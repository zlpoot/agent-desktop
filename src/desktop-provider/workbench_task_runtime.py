"""Private original-target Task adapter. No global input or desktop activation.

Runs on one serialized native thread. Control heartbeats/revocation arrive on the
pipe reader so a slow UIA query cannot silently extend or bypass the input lease.
Resource duration (60s), input lease (3s), text (512), queue (16), actions (256)
remain bounded. RegistryFence holds revocation and effect commitment together.
"""
import ctypes as C
from ctypes import wintypes as W
import hashlib
import json
import os
import threading
import time
import uuid

from uia import Uia
from policy import Blocked, TEXT_LIMIT, LEASE_SECONDS, HUMAN_LIMIT

ROLES = {50000: 'button', 50002: 'checkbox', 50003: 'combobox', 50004: 'textbox',
         50005: 'link', 50006: 'image', 50007: 'listitem', 50008: 'list',
         50009: 'menu', 50010: 'menubar', 50011: 'menuitem', 50012: 'progressbar',
         50013: 'radio', 50014: 'scrollbar', 50015: 'slider', 50018: 'tab',
         50019: 'tabitem', 50020: 'text', 50023: 'tree', 50024: 'treeitem',
         50025: 'custom', 50026: 'group', 50028: 'datagrid', 50029: 'dataitem',
         50030: 'document', 50032: 'window', 50033: 'pane'}
KEYS = {'ENTER': 13, 'RETURN': 13, 'ESC': 27, 'ESCAPE': 27, 'TAB': 9,
        'BACKSPACE': 8, 'DELETE': 46, 'HOME': 36, 'END': 35,
        'LEFT': 37, 'UP': 38, 'RIGHT': 39, 'DOWN': 40}
ACTIONS = ('click', 'double_click', 'type', 'paste_text', 'keypress', 'scroll', 'wait', 'screenshot')


def refused(code):
    raise ValueError('workbench-task-' + code)


def role(value):
    value = ''.join(character for character in value.lower() if character.isalnum())
    return {'edit': 'textbox', 'hyperlink': 'link', 'radiobutton': 'radio', 'static': 'text'}.get(value, value)


class TargetApi:
    """UIA guard for the pinned root and its Job-owned children; not another desktop."""
    def __init__(self, tasks, record):
        self.tasks, self.record = tasks, record
        self.u, self.k = tasks.worker.api.u, tasks.worker.api.k

    def guard(self, hwnd, _expected):
        self.tasks.target_current(self.record)
        root = self.u.GetAncestor(hwnd, 2)
        pid = W.DWORD()
        if not self.u.IsWindow(hwnd) or root != self.record['hwnd'] or not self.u.GetWindowThreadProcessId(hwnd, C.byref(pid)):
            refused('window-outside-original-target')
        if not self.owned_process(pid.value) or self.session(pid.value) != self.tasks.worker.context['windowsSessionId']:
            refused('window-outside-owned-job')

    def identity(self, hwnd):
        self.guard(hwnd, None)
        pid = W.DWORD(); self.u.GetWindowThreadProcessId(hwnd, C.byref(pid))
        return {'alive': True, 'in_job': True, 'desktop': self.tasks.worker.name,
                'session': self.session(pid.value), 'pid': pid.value}

    def input_guard(self, hwnd, expected):
        self.guard(hwnd, expected)
        self.tasks.authorized(self.record)

    def owned_process(self, pid):
        if not self.tasks.worker.api.owned_process(pid): return False
        return self.tasks.worker.native.token(pid)[0] == self.tasks.owner

    def session(self, pid):
        return self.tasks.worker.api.session(pid)


class WorkbenchTasks:
    def __init__(self, worker):
        self.worker = worker
        self.instance = uuid.uuid4().hex
        self.resource = 'workbench-apps:' + self.instance
        self.owner = worker.native.token(os.getpid())[0]
        self.sessions = {}
        self.control_lock = threading.RLock()
        self.grant = None
        self.grant_deadline = 0
        self.revoked = threading.Event()
        self.revoked.set()
        self.epoch = 0
        self.sequence = 0
        u = worker.api.u
        u.GetClientRect.argtypes, u.GetClientRect.restype = [W.HWND, C.POINTER(W.RECT)], W.BOOL
        u.ScreenToClient.argtypes, u.ScreenToClient.restype = [W.HWND, C.POINTER(W.POINT)], W.BOOL
        u.MapWindowPoints.argtypes, u.MapWindowPoints.restype = [W.HWND, W.HWND, C.POINTER(W.POINT), W.UINT], C.c_int
        u.ChildWindowFromPointEx.argtypes, u.ChildWindowFromPointEx.restype = [W.HWND, W.POINT, W.UINT], W.HWND
        u.GetWindowTextW.argtypes, u.GetWindowTextW.restype = [W.HWND, W.LPWSTR, C.c_int], C.c_int

    def record(self, session):
        if not isinstance(session, dict) or session.get('instanceId') != self.instance or session.get('inputResourceId') != self.resource:
            refused('stale-session')
        record = self.sessions.get(session.get('sessionId'))
        if not record or record['session'] != session or record.get('closed'):
            refused('stale-session')
        return record

    def open(self):
        if len(self.sessions) >= 128 or self.worker.blocked:
            refused('session-limit-or-blocked')
        session = {'providerId': self.worker.scope['providerId'], 'environmentId': self.worker.scope['environmentId'],
                   'sessionId': uuid.uuid4().hex, 'instanceId': self.instance, 'inputResourceId': self.resource}
        self.sessions[session['sessionId']] = {'session': session, 'receipts': {}, 'actions': 0}
        return session

    def target_current(self, record):
        self.worker.current()
        if not record.get('target') or self.worker.token != record['receipt']['targetToken'] or self.worker.hwnd != record['hwnd']:
            refused('original-target-lost')
        if self.worker.profile is None or self.worker.profile['profileDigest'] != record['profile']['profileDigest']:
            refused('original-profile-changed')
        for key in ('scope', 'sessionId', 'instanceId', 'windowsSessionId', 'desktop'):
            if record['receipt'][key] != self.worker.context[key]:
                refused('original-context-changed')
        self.worker.api.guard(record['hwnd'], {'pid': self.worker.pid, 'desktop': self.worker.name,
            'session': self.worker.context['windowsSessionId']}, desktop=self.worker.desktop)
        pid = W.DWORD(); tid = self.worker.api.u.GetWindowThreadProcessId(record['hwnd'], C.byref(pid))
        if tid != record['thread'] or pid.value != self.worker.pid:
            refused('original-window-changed')

    def bind(self, record, profile, receipt):
        if record.get('cleaned'): refused('session-already-cleaned')
        keys = ('scope', 'appBindingId', 'installationId', 'applicationId', 'profileRevision', 'profileDigest', 'identity', 'launchSpec')
        if receipt.get('targetToken') != self.worker.token or not self.worker.profile or \
                any(profile.get(key) != self.worker.profile.get(key) for key in keys):
            refused('issuer-target-unavailable')
        if len(self.worker.instances(profile)) != 1:
            refused('original-window-unconfirmed')
        if receipt.get('identity') != profile.get('identity'):
            refused('installation-mismatch')
        if record.get('target') and record['receipt'] != receipt:
            refused('replacement-target-forbidden')
        for other in self.sessions.values():
            if other is not record and not other.get('closed') and other.get('receipt') == receipt:
                refused('target-already-bound')
        if not record.get('target'):
            pid = W.DWORD(); thread = self.worker.api.u.GetWindowThreadProcessId(self.worker.hwnd, C.byref(pid))
            record.update({'profile': profile, 'receipt': receipt, 'hwnd': self.worker.hwnd, 'thread': thread,
                'target': {**record['session'], 'targetId': uuid.uuid4().hex,
                           'application': profile['applicationId'], 'applicationVersion': profile['identity']['version'],
                           'targetRole': 'owned-window'}})
        self.worker.api.join_job_view(self.worker.name + '_job')
        self.target_current(record)
        return record['target']

    def status(self, record):
        ready = not self.worker.blocked
        if record.get('target'):
            try: self.target_current(record)
            except Exception: ready = False
        return {'state': 'open' if ready else 'stale', 'readiness': {
            name: {'state': 'ready' if ready else 'not-ready'} for name in
            ('observation.pixels', 'observation.accessibility', 'control.leaseProtected', 'input.semantic', 'input.targetedWindow')}}

    def control(self, method, fields):
        record = self.record(fields.get('session'))
        authority = fields.get('authority')
        if method == 'task_revoke' and isinstance(authority, dict) and self.grant == authority:
            self.revoked.set()  # Signal immediately, even while an effect is draining.
        with self.control_lock:
            if not isinstance(authority, dict) or any(authority.get(key) != value for key, value in record['session'].items()) or \
                    authority.get('owner', {}).get('kind') != 'agent' or not authority['owner'].get('clientId') or \
                    type(authority.get('epoch')) is not int or not isinstance(authority.get('grantId'), str) or not authority['grantId']:
                refused('invalid-authority')
            if method == 'task_activate':
                if self.grant or authority['epoch'] <= self.epoch or not record.get('target'):
                    refused('input-busy-or-stale')
                self.epoch = authority['epoch']; self.grant = authority
                self.grant_deadline = time.monotonic() + LEASE_SECONDS
                self.revoked.clear()
            elif method == 'task_heartbeat':
                self.authorized(record, authority)
                self.grant_deadline = time.monotonic() + LEASE_SECONDS
            elif method == 'task_revoke':
                if self.grant and self.grant != authority:
                    refused('foreign-authority')
                self.grant = None; self.grant_deadline = 0
                self.revoked.set()
            else: refused('control-unavailable')
        return None

    def authorized(self, record, authority=None):
        with self.control_lock:
            if self.revoked.is_set() or self.grant is None or self.grant.get('sessionId') != record['session']['sessionId'] or \
                    time.monotonic() >= self.grant_deadline or authority is not None and authority != self.grant:
                refused('input-authority-lost')

    def window(self, record):
        self.target_current(record)
        hwnd = record['hwnd']; api = self.worker.api
        rect = W.RECT(); api.checked(api.u.GetWindowRect(hwnd, C.byref(rect)), 'window_rect')
        title = C.create_unicode_buffer(2048); api.u.GetWindowTextW(hwnd, title, 2048)
        return {'handle': hwnd, 'title': title.value, 'windowClass': api.class_name(hwnd), 'processId': self.worker.pid,
                'processPath': record['profile']['launchSpec']['executable'], 'targetElevated': False,
                'visible': bool(api.u.IsWindowVisible(hwnd)), 'minimized': False, 'foreground': False,
                'rect': {'left': rect.left, 'top': rect.top, 'width': rect.right-rect.left, 'height': rect.bottom-rect.top}}

    def tree(self, record):
        self.target_current(record)
        return Uia(TargetApi(self, record), record['hwnd'], {'pid': self.worker.pid,
            'desktop': self.worker.name, 'session': self.worker.context['windowsSessionId']})

    def observe(self, record, screen_capture):
        window = self.window(record)
        started = time.monotonic() * 1000
        tree = self.tree(record)
        items, labels = [], []
        try:
            for row in tree.observe():
                complete = len(row['name']) <= 300
                item = {'role': ROLES.get(row['role'], 'custom'), 'name': row['name'][:300],
                        'text': row['name'][:300], 'complete': complete}
                if row['role'] in (50004, 50003):
                    try:
                        value = tree.value(row['index']); item['value'] = value[:512]
                        item['complete'] = complete and len(value) <= 512
                    except Blocked: item['complete'] = False
                if row['role'] == 50002:
                    item['complete'] = False  # Toggle state is not inferred from name or pixels.
                items.append(item)
                labels.append(f"{item['role']} | {row['name'][:120]} | autoId={row['auto_id']}")
        finally: tree.close()
        capture = self.worker.preview(record['profile']) if screen_capture else None
        self.target_current(record)
        self.sequence += 1
        observation = {'windowHandle': window['handle'], 'windowTitle': window['title'], 'windowRect': window['rect'],
            'desktopPath': self.worker.context['desktop'], 'structured': {'source': 'uia', 'complete': True, 'items': items},
            'accessibility': '\n'.join(labels)[:2000], 'pageText': '\n'.join(item['name'] for item in items)[:2000],
            'capture': {'epoch': record['target']['targetId'], 'sequence': self.sequence, 'object': str(window['handle']),
                        'startedAt': started, 'finishedAt': time.monotonic()*1000, 'clock': 'collector', 'atomic': False,
                        'enumerationComplete': True, 'fields': {'structured': {'complete': True, 'source': 'uia'},
                                                             'accessibility': {'complete': len('\n'.join(labels)) <= 2000, 'source': 'uia'},
                                                             'pageText': {'complete': sum(len(item['name'])+1 for item in items) <= 2000, 'source': 'uia'}}}}
        observation['textEvidence'] = [{'source': 'uia', 'text': observation['pageText']}]
        # Keep the original pipe budget. Truncation is explicit and cannot prove uniqueness.
        while len(json.dumps(observation, ensure_ascii=False).encode('utf-8')) > 115000 and items:
            items.pop(); observation['structured']['complete'] = False
            observation['capture']['enumerationComplete'] = False
            observation['capture']['fields']['structured']['complete'] = False
        return {'observation': observation, **({'capture': capture} if capture else {})}

    def validate_action(self, action):
        if not isinstance(action, dict) or action.get('kind') not in ACTIONS:
            refused('action-unavailable')
        kind = action['kind']
        if kind in ('type', 'paste_text') and (not isinstance(action.get('text'), str) or len(action['text']) > TEXT_LIMIT or '\0' in action['text']):
            refused('text-limit')
        if kind == 'keypress' and str(action.get('keys', '')).upper() not in KEYS:
            refused('key-unavailable')
        if kind == 'wait' and (type(action.get('ms')) is not int or not 0 <= action['ms'] <= 2000):
            refused('wait-limit')
        if kind == 'scroll' and (action.get('direction') not in ('up', 'down') or
                type(action.get('amount')) not in (int, float) or not 0 < action['amount'] <= 720):
            refused('scroll-limit')

    def locate(self, record, spec):
        if not isinstance(spec, dict): refused('target-required')
        if spec.get('kind') == 'coordinate':
            window = self.window(record)
            if any(type(spec.get(key)) is not int for key in ('x', 'y')) or not \
                    (0 <= spec['x'] < window['rect']['width'] and 0 <= spec['y'] < window['rect']['height']):
                refused('coordinate-outside-target')
            return None, {'rect': [window['rect']['left']+spec['x'], window['rect']['top']+spec['y'],
                                  window['rect']['left']+spec['x']+1, window['rect']['top']+spec['y']+1]}, None
        tree = self.tree(record)
        try:
            found = []
            for row in tree.observe():
                kind = spec.get('kind')
                if kind == 'role':
                    match = role(ROLES.get(row['role'], 'custom')) == role(spec.get('role', '')) and \
                        (spec.get('name') is None or row['name'] == spec['name'])
                elif kind == 'label': match = row['name'] == spec.get('label')
                elif kind == 'text': match = bool(spec.get('text')) and spec['text'] in row['name']
                elif kind == 'selector':
                    value = spec.get('selector', '')
                    match = value.startswith('autoId=') and row['auto_id'] == value[7:]
                else: refused('locator-unavailable')
                if match: found.append(row)
            if len(found) != 1: refused('target-not-unique')
            row = found[0]
            if not row['enabled'] or row['offscreen']: refused('target-not-usable')
            return tree, row, tree.elements[row['index']]
        except BaseException:
            tree.close(); raise

    def reset(self, record):
        prepared = record.pop('prepared', None)
        if prepared and prepared.get('tree'): prepared['tree'].close()

    def prepare(self, record, action):
        self.validate_action(action); self.target_current(record); self.reset(record)
        tree = row = element = None
        kind = action['kind']
        if kind in ('click', 'double_click', 'type', 'paste_text') or kind == 'scroll' and action.get('target'):
            if kind in ('type', 'paste_text') and action['target'].get('kind') == 'coordinate':
                refused('semantic-text-target-required')
            tree, row, element = self.locate(record, action['target'])
        elif kind == 'keypress':
            if not record.get('last_input'): refused('keyboard-target-required')
            tree, row, element = self.locate(record, record['last_input'])
        observation = {**record['target'], 'observationId': uuid.uuid4().hex}
        record['prepared'] = {'tree': tree, 'row': row, 'element': element, 'action': action,
                              'observation': observation, 'created': time.monotonic(), 'window': self.window(record)}
        return {'observation': observation}

    def receiver(self, record, row):
        window = self.window(record)
        rect = row['rect'] if row else [window['rect']['left'], window['rect']['top'],
                window['rect']['left']+window['rect']['width'], window['rect']['top']+window['rect']['height']]
        point = W.POINT((rect[0]+rect[2])//2, (rect[1]+rect[3])//2)
        hwnd = record['hwnd']; u = self.worker.api.u
        self.worker.api.checked(u.ScreenToClient(hwnd, C.byref(point)), 'screen_to_client')
        for _ in range(16):
            child = u.ChildWindowFromPointEx(hwnd, point, 3)  # Skip invisible/disabled children.
            if not child or child == hwnd: break
            C.set_last_error(0)
            moved = u.MapWindowPoints(hwnd, child, C.byref(point), 1)
            if not moved and C.get_last_error(): refused('coordinate-map-failed')
            hwnd = child
        else: refused('input-depth-limit')
        TargetApi(self, record).guard(hwnd, None)
        client = W.RECT(); self.worker.api.checked(u.GetClientRect(hwnd, C.byref(client)), 'client_rect')
        if not (0 <= point.x < client.right and 0 <= point.y < client.bottom): refused('coordinate-outside-client')
        return hwnd, point

    def execute(self, record, fields):
        action, action_id = fields.get('action'), fields.get('actionId')
        if not isinstance(action_id, str) or not action_id or len(action_id) > 128: refused('action-id-required')
        digest = hashlib.sha256(json.dumps(action, sort_keys=True, ensure_ascii=True).encode()).hexdigest()
        self.authorized(record, fields.get('authority'))
        self.target_current(record)
        if fields.get('target') != record['target']: refused('original-target-required')
        old = record['receipts'].get(action_id)
        if old:
            if old['digest'] != digest: refused('action-id-conflict')
            return old['result']
        prepared = record.get('prepared')
        self.authorized(record, fields.get('authority'))
        if not prepared or fields.get('target') != record['target'] or fields.get('observation') != prepared['observation'] or \
                action != prepared['action'] or time.monotonic()-prepared['created'] > 2:
            refused('fresh-observation-required')
        if record['actions'] >= HUMAN_LIMIT: refused('action-budget-exhausted')
        self.validate_action(action)
        self.target_current(record)
        if self.window(record)['rect'] != prepared['window']['rect']: refused('target-geometry-changed')
        record['actions'] += 1
        result = {'ok': False, 'effect': 'uncertain', 'message': 'workbench-task-effect-unknown', 'provider': 'hidden-desktop-targeted'}
        record['receipts'][action_id] = {'digest': digest, 'result': result}
        effects = [False]
        def effect():
            with self.control_lock:
                self.authorized(record, fields.get('authority')); self.target_current(record)
                kind = action['kind']; row, tree = prepared['row'], prepared['tree']
                if tree:
                    element = prepared['element']; tree.owned(element)
                    if not tree.integer(element, 28) or tree.integer(element, 38) or tree.integer(element, 21) != row['role']:
                        refused('target-not-usable')
                    spec = action.get('target') or record.get('last_input') or {}
                    if spec.get('kind') in ('label', 'text') or spec.get('kind') == 'role' and spec.get('name') is not None:
                        if tree.string(element, 23) != row['name']: refused('target-semantics-changed')
                    if spec.get('kind') == 'selector' and tree.string(element, 29) != row['auto_id']:
                        refused('target-semantics-changed')
                if kind in ('type', 'paste_text'):
                    # Resolve the pattern before commitment: unsupported is provably no-effect.
                    pattern = tree.pattern(row['index'], 10002, 'a94cd8b1-0844-4cd6-9d2d-640537ab39e9', False)
                    try:
                        self.authorized(record); self.target_current(record); effects[0] = True
                        pattern.call(3, (W.LPCWSTR,), (action['text'],))
                    finally: pattern.close()
                    record['last_input'] = action['target']
                elif kind in ('click', 'double_click', 'keypress', 'scroll'):
                    if tree:
                        rect = W.RECT(); prepared['element'].call(43, (C.POINTER(W.RECT),), (C.byref(rect),))
                        if [rect.left, rect.top, rect.right, rect.bottom] != row['rect']: refused('target-geometry-changed')
                    hwnd, point = self.receiver(record, row)
                    position = (point.x & 0xffff) | ((point.y & 0xffff) << 16)
                    if kind == 'keypress':
                        if tree and not tree.integer(prepared['element'], 26): refused('keyboard-target-not-focused')
                        vk = KEYS[action['keys'].upper()]; messages = [(0x100, vk, 1)]
                        if vk in (8, 9, 13): messages.append((0x102, vk, 1))
                        messages.append((0x101, vk, 0xc0000001))
                    elif kind == 'scroll':
                        delta = 120 if action['direction'] == 'up' else -120
                        screen = W.POINT(point.x, point.y)
                        self.worker.api.checked(self.worker.api.u.ClientToScreen(hwnd, C.byref(screen)), 'client_to_screen')
                        messages = [(0x20a, (delta & 0xffff) << 16, (screen.x & 0xffff) | ((screen.y & 0xffff) << 16))] * max(1, int(action['amount']/120))
                    else:
                        messages = [(0x200, 0, position), (0x201, 1, position), (0x202, 0, position)]
                        if kind == 'double_click': messages += [(0x203, 1, position), (0x202, 0, position)]
                    try:
                        for message, buttons, coords in messages:
                            self.authorized(record); TargetApi(self, record).guard(hwnd, None)
                            effects[0] = True; self.worker.api.send(hwnd, message, buttons, coords)
                    finally:
                        TargetApi(self, record).guard(hwnd, None)
                        self.worker.api.send(hwnd, 0x1f)  # Target-local cancel; cleanup after revocation is allowed.
                    if action.get('target') and action['target']['kind'] != 'coordinate': record['last_input'] = action['target']
                elif kind == 'wait': time.sleep(action['ms']/1000)
                self.target_current(record)
        try:
            self.worker.fence.run(record['profile'], effect, verified=True)
            result.update(ok=True, effect='dispatched' if effects[0] else 'none', message='定向调用完成；结果由后续独立观察核验')
        except Exception as error:
            result.update(effect='uncertain' if effects[0] else 'none', message=str(error) if isinstance(error, (ValueError, Blocked)) else 'workbench-task-native-operation-failed')
        finally: self.reset(record)
        return result

    def cleanup(self, record):
        if record.get('cleaned'): return {'cleaned': True}
        self.reset(record)
        # Only reclaim the exact original token/context, never an unrelated newer APP.
        if record.get('receipt') and self.worker.context:
            if self.worker.token != record['receipt']['targetToken'] or self.worker.context['instanceId'] != record['receipt']['instanceId']:
                refused('cleanup-original-target-required')
            self.worker.close()
        if self.worker.blocked: refused('cleanup-unconfirmed')
        record['cleaned'] = True
        return {'cleaned': True}

    def dispatch(self, method, fields):
        if method == 'task_session_open': return self.open()
        record = self.record(fields.get('session'))
        if method == 'task_status': return self.status(record)
        if method == 'task_bind': return self.bind(record, fields['profile'], fields['target'])
        if method == 'task_cleanup': return self.cleanup(record)
        if method == 'task_reset': self.reset(record); return None
        if method == 'task_revoke': self.reset(record); return None  # Reader already invalidated; this is drain/ACK.
        if method == 'task_session_close':
            self.cleanup(record); record['closed'] = True; return None
        self.target_current(record)
        if method == 'task_windows':
            window = self.window(record); filters = fields.get('filter', {})
            return [window] if all(window.get({'windowTitle': 'title', 'windowClass': 'windowClass', 'processPath': 'processPath'}.get(key, key)) == value for key, value in filters.items()) else []
        if method == 'task_probe':
            window = self.window(record)
            tree = self.tree(record)
            tree.close()
            return {**window, 'title': window['title'], 'permissionsCompatible': True, 'elevated': False, 'uiaControls': True}
        if method in ('task_attach', 'task_restore'):
            expected = fields.get('options', {}) if method == 'task_attach' else fields.get('observation', {})
            window = self.window(record)
            names = {'windowHandle': 'handle', 'windowTitle': 'title', 'windowClass': 'windowClass', 'processPath': 'processPath', 'processId': 'processId'}
            if any(key in expected and expected[key] != window[value] for key, value in names.items()): refused('replacement-target-forbidden')
            return None
        if method == 'task_observe': return self.observe(record, fields.get('screenCapture', True))
        if method == 'task_prepare': return self.prepare(record, fields['action'])
        if method == 'task_ground':
            action = fields['action']; self.validate_action(action)
            target = action.get('target')
            if not target:
                return {'attempts': []}
            attempts = []
            options = target.get('options', []) if target.get('kind') == 'candidates' else [target]
            for spec in options[:16]:
                try:
                    tree, _, _ = self.locate(record, spec)
                    if tree: tree.close()
                    attempts.append({'strategy': spec['kind'], 'matched': True, 'selected': True, 'detail': '原目标内唯一匹配'})
                    return {'target': spec, 'attempts': attempts}
                except (ValueError, Blocked) as error:
                    attempts.append({'strategy': spec.get('kind', 'role'), 'matched': False, 'selected': False, 'detail': str(error)})
            return {'attempts': attempts}
        if method == 'task_execute': return self.execute(record, fields)
        refused('command-unavailable')
