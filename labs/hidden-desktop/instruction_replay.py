"""可组合的窗口/文本容器指令；应用选择器、内容和完成标志只来自 JSON。

复用 LearnedReplay 的队列、锁、追踪、预算及失败清理。这里只解释有限指令，
不执行 JSON 中的代码，不持久化 COM 或提交回执，不自动重试输入。
"""
import copy
import math
import os
import re
import time
from pathlib import Path

from capabilities import CapabilityError
from replay_contract import ReplayError, valid_window_size
from skill_composition import SkillLibrary, digest, identifier, read_json, substitute
from app_startup import select_started_window


FIELDS = {'roleName', 'name', 'autoId', 'className', 'namePrefix', 'nameSuffix', 'classes'}
SHAPES = {
    'ensure_app': set(),
    'open_entry': {'selector', 'match', 'readyTimeoutMs'},
    'verify_page': {'markers', 'container', 'readyTimeoutMs'},
    'verify_container': {'container', 'ancestryStrategy'},
    'capture': set(),
    'fill_container': {'container', 'emptyText', 'text', 'ancestryStrategy', 'receipt'},
    'submit_container': {'container', 'text', 'button', 'sendContainer', 'ancestryStrategy', 'requires', 'receipt'},
    'read_response': {'text', 'scope', 'completed', 'footer', 'requires', 'verification'},
}


def require(ok, reason):
    if not ok:
        raise ReplayError(reason)


def selector(spec):
    require(isinstance(spec, dict) and bool(spec) and not set(spec)-FIELDS, 'invalid-row-selector')
    require(isinstance(spec.get('roleName'), str) and bool(spec['roleName']), 'missing-selector-role')
    for key, value in spec.items():
        if key == 'classes':
            require(isinstance(value, list) and 1 <= len(value) <= 8
                    and all(isinstance(v, str) and 1 <= len(v) <= 512 for v in value), 'invalid-selector-classes')
        else:
            require(isinstance(value, str) and 1 <= len(value) <= 512, 'invalid-selector-string')


def matches(row, spec):
    for key, value in spec.items():
        if key == 'classes':
            if row.get('className') not in value: return False
        elif key == 'namePrefix':
            if not row.get('name', '').startswith(value): return False
        elif key == 'nameSuffix':
            if not row.get('name', '').endswith(value): return False
        elif row.get(key) != value: return False
    return True


def inside(outer, inner):
    def rect(r):
        return isinstance(r, list) and len(r) == 4 and all(type(n) in (int, float) and math.isfinite(n) for n in r) and r[0] < r[2] and r[1] < r[3]
    return rect(outer) and rect(inner) and outer[0] <= inner[0] and outer[1] <= inner[1] and outer[2] >= inner[2] and outer[3] >= inner[3]


def unique(rows, spec):
    found = [r for r in rows if matches(r, spec)]
    require(len(found) == 1, 'target-match-count:' + str(len(found)))
    require(found[0].get('enabled') is True and found[0].get('offscreen') is False, 'target-not-available')
    return found[0]


def validate_instruction_recipe(data, _learned=False):
    require(isinstance(data, dict) and data.get('schemaVersion') == 1
            and data.get('executionModel') == 'capability-steps' and data.get('kind') == 'learned-capability'
            and identifier(data.get('id')) and type(data.get('revision')) is int, 'invalid-instruction-capability')
    require(set(data) == {'schemaVersion', 'kind', 'executionModel', 'id', 'revision', 'title', 'profile',
                         'profileSha256', 'parameters', 'operations', 'preconditions', 'verification'}, 'invalid-instruction-fields')
    require(isinstance(data['title'], str) and 1 <= len(data['title']) <= 512
            and identifier(data['profile']) and re.fullmatch('[0-9a-f]{64}', str(data['profileSha256'])), 'invalid-instruction-profile')
    require(isinstance(data['parameters'], dict) and len(data['parameters']) <= 8, 'invalid-instruction-parameters')
    for key, spec in data['parameters'].items():
        require(identifier(key) and isinstance(spec, dict) and set(spec) == {'type', 'minLength', 'maxLength'}
                and spec['type'] == 'string' and type(spec['minLength']) is int and type(spec['maxLength']) is int
                and 1 <= spec['minLength'] <= spec['maxLength'] <= 512, 'invalid-instruction-parameter')
    operations = data['operations']
    require(isinstance(operations, list) and len(operations) == 1, 'invalid-instruction-operation')
    operation = operations[0]
    require(isinstance(operation, dict) and set(operation) == {'id', 'title', 'description', 'inputs', 'steps', 'completion', 'acceptance'}
            and operation['id'] == data['id'] and isinstance(operation['inputs'], list)
            and set(operation['inputs']) == set(data['parameters']) and len(operation['inputs']) == len(data['parameters'])
            and operation['acceptance'] in ('manual', 'automatic'), 'invalid-instruction-operation')
    require(all(isinstance(operation[k], str) and 1 <= len(operation[k]) <= 512
                for k in ('title', 'description', 'completion')), 'invalid-instruction-description')
    steps = operation['steps']
    require(isinstance(steps, list) and 1 <= len(steps) <= 8, 'invalid-instruction-steps')
    for step in steps:
        require(isinstance(step, dict) and step.get('op') in SHAPES
                and set(step) == {'op'} | SHAPES[step['op']], 'invalid-instruction-step')
        for key in ('match', 'container', 'button', 'sendContainer', 'scope', 'completed', 'footer'):
            if key in step: selector(step[key])
        if 'markers' in step:
            require(isinstance(step['markers'], list) and 1 <= len(step['markers']) <= 8, 'invalid-page-markers')
            for marker in step['markers']: selector(marker)
        if 'ancestryStrategy' in step:
            require(step['ancestryStrategy'] in ('full-tree', 'owned-native-anchor'), 'invalid-ancestry-strategy')
        if 'readyTimeoutMs' in step:
            require(type(step['readyTimeoutMs']) is int and 1 <= step['readyTimeoutMs'] <= 15000, 'invalid-ready-timeout')
        for key in ('receipt', 'requires'):
            if key in step: require(identifier(step[key]), 'invalid-instruction-receipt')
        for key in ('text', 'emptyText', 'verification'):
            if key in step: require(isinstance(step[key], str) and 1 <= len(step[key]) <= 512, 'invalid-instruction-text')
        if 'selector' in step:
            s = step['selector']
            require(isinstance(s, dict) and set(s) == {'kind', 'role', 'value'} and s['kind'] == 'role'
                    and all(isinstance(s[k], str) and 1 <= len(s[k]) <= 512 for k in ('role', 'value')), 'invalid-entry-selector')
    # 替换也在提交任何动作前做完整预检；未知参数不能在输入之后才发现。
    substitute(steps, {p: 'synthetic' for p in data['parameters']})
    conditions = data['preconditions']
    require(isinstance(conditions, dict) and set(conditions) == {'ownedApplication', 'boundTargets', 'verifiedInput', 'absentStates'}
            and type(conditions['ownedApplication']) is bool and conditions['boundTargets'] == []
            and isinstance(conditions['absentStates'], list) and len(conditions['absentStates']) <= 8
            and all(identifier(s) for s in conditions['absentStates']), 'invalid-instruction-preconditions')
    verified = conditions['verifiedInput']
    require(verified is None or isinstance(verified, dict) and set(verified) == {'state', 'parameter'}
            and identifier(verified['state']) and verified['parameter'] in data['parameters'], 'invalid-instruction-receipt-precondition')
    require(isinstance(data['verification'], dict) and data['verification'].get('status') in
            ('packaged-pending-replay', 'recorded'), 'invalid-verification-provenance')
    return data


class InstructionLibrary(SkillLibrary):
    execution_model = 'capability-steps'

    def __init__(self, workflow_path, capabilities_dir, profiles_dir):
        super().__init__(workflow_path, capabilities_dir, validate_instruction_recipe)
        self.profiles_dir = Path(profiles_dir).resolve()

    def runtime_recipe(self, recipe):
        path = (self.profiles_dir / (recipe['profile'] + '.json')).resolve()
        require(path.parent == self.profiles_dir, 'profile-outside-library')
        profile = read_json(path)
        require(digest(profile) == recipe['profileSha256'], 'profile-changed-learning-required')
        app, env, fp = profile['application'], profile['environment'], profile['applicationFingerprint']
        require(profile.get('schemaVersion') == 1 and os.path.isabs(app['executable'])
                and app['executable'].lower().endswith('.exe') and isinstance(app['arguments'], str) and len(app['arguments']) <= 1024
                and env['kind'] == 'hidden-desktop' and env['window']['kind'] == 'className'
                and isinstance(env['window']['value'], str) and bool(env['window']['value'])
                and set(profile['mainWindow']) == {'title', 'className'}
                and all(isinstance(v, str) and 1 <= len(v) <= 256 for v in profile['mainWindow'].values())
                and profile['mainWindow']['className'] == env['window']['value']
                and valid_window_size(env.get('size'))
                and fp['path'] == app['executable'] and type(fp['size']) is int and fp['size'] > 0
                and re.fullmatch('[0-9a-f]{64}', fp['sha256']), 'invalid-application-profile')
        return {**recipe, 'application': app, 'environment': env, 'mainWindow': profile['mainWindow'],
                'learning': {'applicationFingerprint': fp}}

    def capability(self, capability_id):
        recipe = super().capability(capability_id)
        self.runtime_recipe(recipe)
        return recipe

    def summary(self):
        result = super().summary()
        result['executionModel'] = self.execution_model
        result['contracts'] = [dict(id=r['id'], title=r['title'], description=r['operations'][0]['description'],
                                    parameters=r['parameters'], targets={}, preconditions=r['preconditions'],
                                    instructions=r['operations'][0]['steps'], recordedVerification=r['verification'])
                               for r in result['capabilities']]
        return result


class TracedStartup:
    """启动衔接仍调用原基础能力，同时将每个子调用写入共用追踪。"""
    def __init__(self, replay):
        self.replay = replay

    @property
    def desktop(self):
        return self.replay.lab.desktop

    def invoke(self, name, arguments):
        return {'result': self.replay.invoke(name, arguments)}


def read_response(rows, cfg, binding):
    """从已核验的可见语义区域提取文本；不把历史回答或不完整片段当作结果。"""
    scope = unique(rows, cfg['scope'])
    local = [r for r in rows if inside(scope['rect'], r.get('rect'))]
    normalized = lambda text: ''.join(text.split())
    questions = [r for r in local if r.get('roleName') == 'Text' and normalized(r.get('name', '')) == normalized(cfg['text'])]
    completed = [r for r in local if matches(r, cfg['completed'])]
    footers = [r for r in local if matches(r, cfg['footer'])]
    require(all(len(found) <= 1 for found in (questions, completed, footers)), 'ambiguous-response-markers')
    if not questions or not completed or not footers: return None
    question, header, footer = [unique(found, {'roleName': found[0]['roleName']}) for found in (questions, completed, footers)]
    require(question['rect'][3] < header['rect'][1] and header['rect'][3] < footer['rect'][1], 'response-order-mismatch')
    area = [r for r in rows if r.get('roleName') in ('Text', 'ListItem') and r.get('name') and r.get('rect')
            and r['rect'][1] > header['rect'][3] and r['rect'][3] < footer['rect'][1]
            and r['rect'][2] > scope['rect'][0] and r['rect'][0] < scope['rect'][2]]
    require(all(inside(scope['rect'], r['rect']) for r in area), 'response-outside-observed-region')
    lists = [r for r in area if r['roleName'] == 'ListItem']
    require(not any(a is not b and inside(a['rect'], b['rect']) for a in lists for b in lists), 'unsupported-nested-response-list')
    fragments = [r for r in area if r['roleName'] == 'ListItem' or not any(inside(item['rect'], r['rect']) for item in lists)]
    require(fragments and all(r.get('enabled') and not r.get('offscreen') for r in fragments), 'response-text-not-available')
    lines = []
    for row in sorted(fragments, key=lambda r: (r['rect'][1], r['rect'][0])):
        line = next((line for line in lines if max(line['top'], row['rect'][1]) < min(line['bottom'], row['rect'][3])), None)
        if line is None:
            line = {'top': row['rect'][1], 'bottom': row['rect'][3], 'items': []}
            lines.append(line)
        line['items'].append(row)
    text = '\n'.join(''.join(r['name'] for r in sorted(line['items'], key=lambda r: r['rect'][0])) for line in lines)
    return {'text': text, 'question': cfg['text'], 'observedAt': time.time(), 'binding': copy.deepcopy(binding),
            'evidence': {'scope': scope, 'question': question, 'completed': header, 'footer': footer, 'fragments': fragments},
            'verification': cfg['verification']}


def run_instructions(replay, recipe, inputs):
    runtime = replay.library.runtime_recipe(recipe)
    operation = recipe['operations'][0]
    require(set(inputs) == set(operation['inputs']), 'capability-input-binding-mismatch')
    params = {}
    for key, spec in recipe['parameters'].items():
        value = inputs[key]
        require(isinstance(value, str) and spec['minLength'] <= len(value.strip()) <= spec['maxLength'], 'invalid-input:' + key)
        params[key] = value.strip()
    steps = substitute(operation['steps'], params)
    result = {'checks': []}
    require(not any(key in replay.values for key in recipe['preconditions']['absentStates']), 'action-already-attempted-reset-required')

    def identity():
        proof = replay.invoke('verify.target.identity')
        require(all(proof.get(k) is True for k in ('ok', 'alive', 'inJob', 'sameUser', 'sameSession')), 'window-ownership-failed')
        _desktop, _hwnd, current, _fp = replay._environment(runtime)
        replay.binding = current
        return current

    def observe():
        identity()
        for attempt in range(3):
            try:
                data = replay.invoke('observe.uia.tree')
                require(data.get('enumerationComplete') is True and isinstance(data.get('items'), list), 'query-incomplete')
                identity()
                return data['items']
            except CapabilityError as error:
                if attempt == 2 or error.code != 'dispatch-effect-unknown' or error.detail != 'uia-hresult-80040201': raise

    def current_input(rows, spec, text):
        row = unique(rows, spec)
        texts = [r for r in rows if r.get('roleName') == 'Text' and r.get('name') and inside(row['rect'], r.get('rect'))]
        require(len(texts) == 1 and texts[0]['name'] == text and texts[0].get('enabled') is True
                and texts[0].get('offscreen') is False, 'input-text-mismatch-do-not-overwrite')
        return row

    def ready(specs, timeout_ms):
        deadline = time.monotonic() + timeout_ms / 1000
        while True:
            rows = observe()
            found = [[r for r in rows if matches(r, spec)] for spec in specs]
            require(all(len(items) <= 1 for items in found), 'ready-target-not-unique')
            if all(items and items[0].get('enabled') is True and items[0].get('offscreen') is False for items in found):
                return rows
            require(time.monotonic() < deadline, 'page-not-ready-timeout')
            time.sleep(min(.2, max(0, deadline-time.monotonic())))  # 只重读，不重放点击或启动。

    def bind(row, strategy):
        identity()
        require(bool(row.get('className')), 'missing-target-class')
        target = {'kind': 'className', 'value': row['className'], 'ancestryStrategy': strategy}
        bound = replay.invoke('locate.structured', target)
        require(bound.get('identity', {}).get('globalUnique') is True and bound['identity'].get('identityRebound') is True
                and all(bound.get(k) == row.get(k) for k in ('roleName', 'className', 'rect')), 'binding-identity-mismatch')
        return {**target, 'expectedIdentity': bound['identity']}

    def click(target):
        identity()
        require(replay.invoke('act.click', {'target': target, 'double': False}).get('dispatched') is True, 'click-effect-unknown-do-not-repeat')

    def capture():
        identity()
        info = replay.invoke('observe.capture', {'allowUnrendered': False})
        require(info.get('unrendered') is False and all(info.get(k) == replay.binding[k] for k in ('hwnd', 'pid', 'instanceId')), 'preview-identity-mismatch')
        result['preview'] = replay.publish_preview(info)

    for step in steps:
        op = step['op']
        if op == 'ensure_app':
            require(not replay.values, 'round-already-started-reset-required')
            # 版本不匹配在启动之前拒绝；不会把新版本自动标记为学会。
            require(replay.fingerprint(runtime['application']['executable']) == runtime['learning']['applicationFingerprint'], 'application-version-changed-learning-required')
            probe = replay.invoke('env.identity.probe')
            if not probe['hiddenDesktopOpen']:
                # 运行线程必须从 Default 控制桌面出发。工具沙箱等其他桌面
                # 不能当作枚举后的恢复点；在启动应用之前明确拒绝这种配置。
                api = replay.lab._fresh().api
                def anchor_default():
                    original = api.thread_desktop()
                    name = api.thread_desktop_name()
                    require(name.lower() == 'default', 'worker-not-on-default-desktop')
                    require(api.set_thread_desktop(original), 'worker-default-bind-failed')
                    require(api.thread_desktop_name().lower() == 'default', 'worker-default-bind-unconfirmed')
                    return {'threadDesktop': name, 'explicitlyBound': True}
                replay.trace('replay.thread.anchor', {}, anchor_default)
                replay.invoke('env.hidden.open')
                require(api.thread_desktop_name().lower() == 'default', 'worker-desktop-changed-after-open')
            app = runtime['application']
            args = {'app': 'custom', 'path': app['executable'], 'args': app['arguments']}
            reused = replay.lab.facts().get('ownedAppRunning')
            rule = copy.deepcopy(runtime['mainWindow'])
            current_hwnd = None
            if not reused:
                result['launch'] = replay.invoke('env.app.launch', args)
            else:
                # 任务标题属于动态内容。先独立核验已选定/自动唯一的自有主窗，
                # 再按其现场标题进行完整候选集唯一核验；绝不转选别的窗口。
                current_hwnd = identity()['hwnd']
                desktop = replay.lab.desktop
                fresh = desktop.describe_window(current_hwnd)
                require(desktop.api.is_root_window(current_hwnd) and fresh['visible'] and bool(fresh['title']), 'reused-main-window-not-available')
                rule['title'] = fresh['title']
            preset = {**args, 'mainWindow': rule}
            result['startup'] = replay.trace('replay.select-main-window', {'selector': rule, 'reusedOwnedWindow': bool(reused)},
                lambda: select_started_window(TracedStartup(replay), args, {'profile': preset}))
            if current_hwnd is not None:
                require(result['startup']['window']['hwnd'] == current_hwnd, 'reused-main-window-changed')
            identity()
            result['layout'] = replay.invoke('act.window.fit', runtime['environment']['size'])
            identity()
        else:
            identity()
            verified = recipe['preconditions']['verifiedInput']
            if verified:
                require(replay.values.get(verified['state']) == params[verified['parameter']], 'current-round-receipt-required')
            if op == 'open_entry':
                rows = ready([step['match']], step['readyTimeoutMs'])
                row = unique(rows, step['match'])
                bound = replay.invoke('locate.structured', step['selector'])
                require(bound.get('identity', {}).get('globalUnique') is True and bound['identity'].get('identityRebound') is True
                        and all(row.get(k) == bound.get(k) for k in ('roleName', 'name', 'rect')), 'entry-identity-mismatch')
                # 新一轮仅由显式的入口点击建立；绝不把旧提交回执带入。
                replay.values.clear()
                click({**step['selector'], 'expectedIdentity': bound['identity']})
            elif op == 'verify_page':
                rows = ready([*step['markers'], step['container']], step['readyTimeoutMs'])
                markers = [unique(rows, spec) for spec in step['markers']]
                container = unique(rows, step['container'])
                require(inside(container['rect'], markers[-1]['rect']), 'placeholder-outside-container')
                result['page'] = {'markers': markers, 'container': container}
            elif op == 'verify_container':
                row = unique(observe(), step['container'])
                target = bind(row, step['ancestryStrategy'])
                for field, expected in [('enabled', True), ('offscreen', False)]:
                    require(replay.invoke('observe.state.read', {'target': target, 'field': field})['value'] is expected, 'container-state-mismatch')
                result['target'] = target
            elif op == 'capture': capture()
            elif op == 'fill_container':
                require(step['receipt'] not in replay.values and not replay.values, 'input-already-attempted-reset-required')
                target = bind(current_input(observe(), step['container'], step['emptyText']), step['ancestryStrategy'])
                # 点击也可能引起焦点类名变化；输入前重新观察并绑定。
                replay.values[step['receipt']] = step['text']
                click(target)
                target = bind(current_input(observe(), step['container'], step['emptyText']), step['ancestryStrategy'])
                identity()
                require(replay.invoke('act.type', {'target': target, 'text': step['text']}).get('dispatched') is True, 'typing-effect-unknown-do-not-repeat')
                current_input(observe(), step['container'], step['text'])
                result['verifiedText'] = step['text']
            elif op == 'submit_container':
                require(replay.values.get(step['requires']) == step['text'] and step['receipt'] not in replay.values, 'submission-not-authorized-or-already-attempted')
                rows = observe()
                current_input(rows, step['container'], step['text'])
                button, container = unique(rows, step['button']), unique(rows, step['sendContainer'])
                require(button['rect'] == container['rect'], 'send-container-geometry-mismatch')
                target = bind(container, step['ancestryStrategy'])
                replay.values[step['receipt']] = step['text']  # 派发前消耗一次性发送机会。
                click(target)
                result['submittedOnce'] = True
                result['acceptance'] = 'pending-independent-response'
            elif op == 'read_response':
                require(replay.values.get(step['requires']) == step['text'], 'no-current-round-submission')
                try:
                    answer = read_response(observe(), step, replay.binding)
                except CapabilityError as error:
                    # 只读 UIA 失败允许用户再次读取；先确认仍是同一实例。
                    # 身份/布局/歧义错误依旧传播，由共用队列清理并停止。
                    identity()
                    return {**result, 'pending': True, 'readError': error.payload(),
                            'completion': '本轮回答读取未完成；可手动重读，不会重新提交。'}
                if answer is None:
                    return {**result, 'pending': True, 'completion': '等待本轮回答；只需再次调用读取回答子能力，不会重新提交。'}
                result['answer'] = answer
                capture()
            result['checks'].append({'instruction': op, 'passed': True})
    return result
