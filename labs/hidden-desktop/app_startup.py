"""应用预设及有界启动衔接；应用选择规则只来自 JSON，不改变基础能力契约。"""
import json
import os
from pathlib import Path
import re
import time

from capabilities import CapabilityError

WINDOW_WAIT_SECONDS = 15


def load_presets(root):
    path = Path(root) / 'app-launch-presets.json'
    if path.stat().st_size > 16384:
        raise ValueError('app-presets-too-large')
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict) or set(data) != {'schemaVersion', 'presets'} \
            or data['schemaVersion'] != 1 or not isinstance(data['presets'], dict) \
            or not 1 <= len(data['presets']) <= 16:
        raise ValueError('invalid-app-presets')
    for key, preset in data['presets'].items():
        if not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', key) or not isinstance(preset, dict) \
                or set(preset) - {'label', 'app', 'path', 'args', 'mainWindow'} \
                or preset.get('app') != 'custom' \
                or not isinstance(preset.get('label'), str) or not 1 <= len(preset['label']) <= 64 \
                or not isinstance(preset.get('path'), str) or not os.path.isabs(preset['path']) \
                or not preset['path'].lower().endswith('.exe') \
                or not isinstance(preset.get('args'), str) or len(preset['args']) > 1024:
            raise ValueError('invalid-app-preset')
        window = preset.get('mainWindow')
        if 'mainWindow' in preset and (not isinstance(window, dict)
                or set(window) != {'className', 'title'}
                or not all(isinstance(v, str) and 1 <= len(v) <= 256 for v in window.values())):
            raise ValueError('invalid-app-window-rule')
    return data['presets']


def normalized_path(path):
    return os.path.normcase(os.path.abspath(path))


def select_started_window(runtime, arguments, presets, *, clock=time.monotonic, sleep=time.sleep):
    """启动一次后只重读窗口；不重发启动、不续租、不回退默认桌面。"""
    if arguments.get('app', 'builtin') == 'builtin':
        return None
    path = normalized_path(arguments.get('path') or '')
    profiles = [p for p in presets.values() if normalized_path(p['path']) == path and 'mainWindow' in p]
    if not profiles:
        return None
    if len(profiles) != 1:
        raise CapabilityError('invalid-argument', 'ambiguous-app-startup-profile')
    rule = profiles[0]['mainWindow']
    desktop = runtime.desktop
    instance = desktop.context['instanceId']
    started = clock()
    deadline = started + WINDOW_WAIT_SECONDS
    attempts = 0

    def current_instance():
        if runtime.desktop is not desktop or not desktop.context or desktop.context['instanceId'] != instance:
            raise CapabilityError('target-identity-changed', 'startup-instance-changed')

    try:
        while True:
            current_instance()
            observed = runtime.invoke('observe.window.enumerate', {})['result']
            current_instance()
            attempts += 1
            found = [w for w in observed['items'] if w['owned'] and w['root']
                     and all(w[k] == v for k, v in rule.items())]
            if len(found) > 1:
                raise CapabilityError('target-not-unique', {'stage': 'startup-window', 'count': len(found)})
            if found and found[0]['visible'] and found[0]['rect'][2] > found[0]['rect'][0] \
                    and found[0]['rect'][3] > found[0]['rect'][1]:
                candidate = found[0]
                selection = runtime.invoke('locate.window', {'kind': 'hwnd', 'value': str(candidate['hwnd'])})['result']
                proof = runtime.invoke('verify.target.identity', {})['result']
                final_windows = runtime.invoke('observe.window.enumerate', {})['result']['items']
                current_instance()
                final_matches = [w for w in final_windows if w['owned'] and w['root']
                                 and all(w[k] == v for k, v in rule.items())]
                if len(final_matches) != 1 or final_matches[0]['hwnd'] != candidate['hwnd']:
                    raise CapabilityError('target-not-unique', {'stage': 'startup-window-recheck', 'count': len(final_matches)})
                fresh = desktop.describe_window(candidate['hwnd'])
                if selection['target'] != candidate['hwnd'] or desktop.target != candidate['hwnd'] \
                        or not all(proof.get(k) is True for k in ('ok', 'alive', 'inJob', 'sameUser', 'sameSession')) \
                        or proof.get('instanceId') != instance or proof.get('pid') != candidate['pid'] \
                        or not proof.get('image') or normalized_path(proof['image']) != path \
                        or not fresh['inJob'] or not fresh['visible'] or fresh['pid'] != candidate['pid'] \
                        or not all(fresh[k] == v for k, v in rule.items()):
                    raise CapabilityError('target-identity-changed', 'startup-window-identity-mismatch')
                return {'selector': rule, 'window': fresh, 'identity': proof, 'attempts': attempts,
                        'elapsedMs': round((clock()-started)*1000, 3), 'unique': True}
            if clock() >= deadline:
                raise CapabilityError('target-windows-absent', {'stage': 'startup-window',
                    'timeoutMs': WINDOW_WAIT_SECONDS*1000, 'attempts': attempts, 'selector': rule})
            sleep(min(.2, deadline-clock()))
    except BaseException:
        # 失败后不让实时预览继续使用尚未通过身份核验的选择。
        if runtime.desktop is desktop and desktop.context and desktop.context['instanceId'] == instance:
            desktop.target = None
        raise
