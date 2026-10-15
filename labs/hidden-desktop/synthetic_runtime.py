"""Synthetic backend for the agent lab. No OS calls, model calls or private inputs.

Uses the existing capability dispatcher, JSON validator, composition library and
LearnedReplay executor. Only the desktop/UIA boundary is replaced with fakes.
"""
import copy
import json
from pathlib import Path
import tempfile
import threading
import time
import uuid

from capabilities import CapabilityRuntime, CapabilityError, NO_USER_IMPACT
from learned_replay import LearnedReplay
from replay_contract import ReplayError, validate_recipe
from skill_composition import SkillLibrary, digest


class FakeTree:
    def __init__(self, desktop, hwnd):
        self.desktop, self.hwnd = desktop, hwnd
        self.owner = threading.get_ident()
        self.elements = [object()]
        self.role = None
        self.closed = False
        desktop.trees.append(self)

    def guard(self):
        if self.closed or self.owner != threading.get_ident():
            raise ReplayError('synthetic-thread-or-lifetime-mismatch')
        self.desktop.guard()
        if self.desktop.stale:
            raise ReplayError('bound-target-changed')

    def _string(self, element, slot):
        self.guard()
        return self.desktop.value if self.role == 'Edit' else 'search'

    def _integer(self, element, slot):
        self.guard()
        return 0

    def prove_target(self, row):
        self.guard()
        return {'runtimeId': [7, row['role']], 'identityRebound': True}

    def value(self, index):
        self.guard()
        return self.desktop.value

    def set_value(self, index, value):
        self.guard()
        self.desktop.value = value
        self.desktop.writes += 1
        if self.desktop.wrong_value:
            self.desktop.value = 'synthetic-mismatch'

    def close(self):
        if self.owner != threading.get_ident():
            raise ReplayError('synthetic-thread-mismatch')
        self.closed = True


class FakeDesktop:
    def __init__(self, clock, lease):
        self.clock, self.deadline = clock, None
        self.instance = uuid.uuid4().hex
        self.context = {'instanceId': self.instance}
        self.api = self
        self.value, self.submitted = '', None
        self.writes = self.clicks = self.frames = 0
        self.stale = self.wrong_value = self.fail_click = self.fail_cleanup = False
        self.trees = []

    def guard(self):
        if self.context is None:
            raise ReplayError('hidden-desktop-not-open')
        if self.deadline is None:
            raise ReplayError('session-not-open')
        if self.clock() >= self.deadline:
            raise ReplayError('lease-expired')

    def window_class(self, hwnd):
        self.guard()
        return 'SyntheticWindow'

    def screen_to_client(self, hwnd, x, y):
        self.guard()
        return x, y

    def click(self, hwnd, x, y, double=False):
        self.guard()
        self.clicks += 1
        self.submitted = self.value
        if self.fail_click:
            raise ReplayError('dispatch-effect-unknown')
        return {'dispatched': True}


class FakeRuntime(CapabilityRuntime):
    """Reuse capability dispatch/error/budget contracts; never construct Native APIs."""
    def __init__(self, executable, clock=time.monotonic):
        super().__init__(lease=300, clock=clock)
        self.executable = executable
        self.desktop = FakeDesktop(clock, self.lease)

    def _target_window(self):
        self.desktop.guard()
        return self.desktop, 123

    def _do_verify_target_identity(self, arguments):
        self.desktop.guard()
        return {'ok': True, 'alive': True, 'image': self.executable, 'pid': 7,
                'session': 5, 'instanceId': self.desktop.instance, 'desktopName': 'synthetic-owned'}

    def _do_observe_window_enumerate(self, arguments):
        self.desktop.guard()
        return {'items': [{'owned': True, 'root': True, 'hwnd': 123, 'className': 'SyntheticWindow'}]}

    def _do_locate_window(self, arguments):
        self.desktop.guard()
        return {'target': 123}

    def _do_observe_capture(self, arguments):
        self.desktop.guard()
        self.desktop.frames += 1
        return {'token': 'synthetic-frame-%d' % self.desktop.frames,
                'unrendered': False, 'scope': 'synthetic-state', 'pixels': False}

    def _do_env_app_close(self, arguments):
        if self.desktop.fail_cleanup:
            raise CapabilityError('cleanup-unconfirmed')
        self.desktop.context = None
        return {'closed': True, 'scope': 'synthetic-only'}

    def _locate(self, tree, selector):
        tree.guard()
        tree.role = selector['role']
        return {'index': 0, 'role': 50004 if tree.role == 'Edit' else 50000,
                'roleName': tree.role, 'name': self.desktop.value if tree.role == 'Edit' else 'search',
                'autoId': '', 'className': '', 'runtimeId': [7, tree.role],
                'native': 0, 'rect': [1, 1, 20, 20], 'identity': {'globalUnique': True}}


class SyntheticBackend:
    mode = 'synthetic'

    def __init__(self, clock=time.monotonic):
        self.temp = tempfile.TemporaryDirectory(prefix='agent-lab-synthetic-')
        root = Path(self.temp.name)
        try:
            recipe = json.loads((Path(__file__).parent / 'synthetic/form.template.json').read_text(encoding='utf-8'))
            recipe['application']['executable'] = str(root / 'synthetic.exe')
            self.lab = FakeRuntime(recipe['application']['executable'], clock)
            fingerprint = {'path': recipe['application']['executable'], 'size': 0, 'sha256': 'a' * 64}
            # Explicit synthetic fixture data, not a claim of real-machine learning.
            recipe['learning'] = {'validation': 'targets-and-patterns-only',
                                  'applicationFingerprint': fingerprint, 'targets': {}}
            for key, spec in recipe['targets'].items():
                role = spec['selector']['role']
                recipe['learning']['targets'][key] = {
                    'role': 50004 if role == 'Edit' else 50000, 'roleName': role,
                    'name': '' if role == 'Edit' else 'search', 'autoId': '', 'className': ''}
            validate_recipe(recipe, True)
            directory = root / 'capabilities'
            directory.mkdir()
            self.definitions = {}
            workflow = {'schemaVersion': 1, 'kind': 'workflow', 'id': 'synthetic.form.submit',
                        'revision': 1, 'title': 'Submit a synthetic form',
                        'completion': 'Synthetic input and dispatch checked; acceptance remains manual.',
                        'automaticRetry': False, 'onFailure': 'stop',
                        'parameters': {key: {'type': 'string', 'maxLength': spec['maxLength']}
                                       for key, spec in recipe['parameters'].items()}, 'steps': []}
            for operation in recipe['operations']:
                child = copy.deepcopy(recipe)
                child.update(id=operation['id'], kind='learned-capability', operations=[operation])
                self.definitions[child['id']] = child
                (directory / (child['id'] + '.json')).write_text(json.dumps(child), encoding='utf-8')
                workflow['steps'].append({'id': 'step-%d' % len(workflow['steps']),
                    'capability': child['id'], 'revision': child['revision'], 'definitionSha256': digest(child),
                    'inputs': {key: {'input': key} for key in operation['inputs']}})
            self.workflow = workflow
            self.workflow_path = root / 'workflow.json'
            self.workflow_path.write_text(json.dumps(workflow), encoding='utf-8')
            self.library = SkillLibrary(self.workflow_path, directory, validate_recipe)
            self.replay = LearnedReplay(self.lab, threading.RLock(), root / 'unused-template.json',
                root / 'unused-learning.json', lambda info: None, tree_factory=FakeTree,
                fingerprint_fn=lambda path: dict(fingerprint), library=self.library)
            self.closed = False
        except BaseException:
            self.temp.cleanup()
            raise

    def catalog(self):
        parameters = self.workflow['parameters']
        result = {self.workflow['id']: {'id': self.workflow['id'], 'kind': 'workflow',
            'title': self.workflow['title'], 'action': 'workflow:' + self.workflow['id'],
            'inputSchema': {'type': 'object', 'properties': {key: {
                'type': 'string', 'minLength': 1, 'maxLength': spec['maxLength']} for key, spec in parameters.items()},
                'required': list(parameters), 'additionalProperties': False},
            'definitionSha256': digest(self.workflow), 'acceptance': 'manual', 'preconditions': []}}
        for key, recipe in self.definitions.items():
            operation = recipe['operations'][0]
            result[key] = {'id': key, 'kind': 'capability', 'title': operation['title'],
                'action': 'capability:' + key, 'definitionSha256': digest(recipe),
                'inputSchema': {'type': 'object', 'properties': {p: {
                    'type': 'string', 'minLength': recipe['parameters'][p]['minLength'],
                    'maxLength': recipe['parameters'][p]['maxLength']} for p in operation['inputs']},
                    'required': operation['inputs'], 'additionalProperties': False},
                'acceptance': operation.get('acceptance', 'automatic'),
                'preconditions': (['targets bound in this session'] if any(
                    step['op'] in ('set_value', 'click') for step in operation['steps']) else [])
                    + (['matching input independently verified before dispatch'] if operation.get('requiresState') else [])}
        for entry in result.values():
            entry['preconditions'] = ['active connection-owned synthetic session', 'lease and action budget available'] + entry['preconditions']
            entry.update(mode=self.mode, revision=1, automaticRetry=False,
                         effects={'desktop': dict(NO_USER_IMPACT), 'business': 'synthetic-state-only'},
                         verificationScope='synthetic-bound-target-live-checks', realWorldValidated=False)
        return result

    def open(self):
        # Opening a connection or inspecting the catalog does not start a lease.
        if self.closed or self.lab.desktop.deadline is not None:
            raise ReplayError('session-already-used')
        self.lab.desktop.deadline = self.lab.clock() + self.lab.lease

    def observation(self):
        self.lab.desktop.guard()
        desktop = self.lab.desktop
        return {'scope': 'synthetic-state', 'pixels': False, 'value': desktop.value,
                'submitted': desktop.submitted, 'writes': desktop.writes, 'clicks': desktop.clicks,
                'actionsUsed': self.lab.actions, 'actionsMax': self.lab.max_actions,
                'leaseRemainingSeconds': max(0, desktop.deadline - desktop.clock())}

    def guard(self):
        self.lab.desktop.guard()

    def availability(self, capability_id):
        if self.closed or self.lab.desktop.context is None:
            return 'unavailable', 'session-closed'
        if self.lab.desktop.deadline is None:
            return 'unavailable', 'session-not-open'
        if self.lab.desktop.clock() >= self.lab.desktop.deadline:
            return 'unavailable', 'lease-expired'
        if self.replay.requires_reset:
            return 'unavailable', 'session-recovery-required'
        if self.replay.busy():
            return 'unavailable', 'task-busy'
        if capability_id != 'synthetic.bind' and self.lab.actions >= self.lab.max_actions:
            return 'unavailable', 'budget-exhausted'
        if capability_id in ('synthetic.fill', 'synthetic.submit') and self.replay.binding is None:
            return 'unavailable', 'binding-required'
        if capability_id == 'synthetic.submit' and 'verifiedQuery' not in self.replay.values:
            return 'unavailable', 'verified-input-required'
        return 'ready', None

    def preflight(self, descriptor, inputs):
        if descriptor['kind'] == 'workflow':
            workflow, _parameters, _plan = self.library.plan(inputs)
            current = digest(workflow)
        else:
            current = digest(self.library.capability(descriptor['id']))
        if current != descriptor['definitionSha256']:
            raise ReplayError('registered-definition-changed')

    def close(self):
        if not self.closed:
            self.replay.shutdown()  # Releases fake UIA references on their owning thread.
            self.closed = True
        try:
            return self.lab.invoke('env.app.close', {})['result']
        finally:
            self.temp.cleanup()
