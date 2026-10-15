"""Opt-in CloudMusic adapter over the existing owned-desktop JSON executor.

Construction/discovery reads definitions only. Native resources are created at
session_open. Only the pinned fill-search workflow and its four children exist.
"""
import copy
import threading
import uuid
from pathlib import Path

from capabilities import CapabilityRuntime, CapabilityError, NO_USER_IMPACT
from hidden_desktop import Blocked
from learned_replay import LearnedReplay, live_target
from live_preview import LivePreview
from replay_contract import ReplayError, fingerprint, validate_recipe
from skill_composition import SkillLibrary, binding_contract, digest, read_json


WORKFLOW = 'cloudmusic.fill-search'
CHILDREN = ('cloudmusic.launch', 'cloudmusic.prepareSearch',
            'cloudmusic.locateSearch', 'cloudmusic.fillSearch')
SCOPE = 'real-owned-window-input-readback'


class RealBackend:
    mode = 'real'

    def __init__(self, root=None):
        self.root = Path(root) if root else Path(__file__).resolve().parent
        self.library = SkillLibrary(self.root / 'recipes/workflows/cloudmusic.fill-search.json',
                                    self.root / 'learned/capabilities', validate_recipe, require_local=True)
        self.workflow, _parameters, plan = self.library.plan({'query': 'configuration-check'})
        if self.workflow['id'] != WORKFLOW or tuple(r['id'] for _s, r, _a in plan) != CHILDREN:
            raise ReplayError('unsupported-real-workflow')
        self.definitions = {recipe['id']: recipe for _s, recipe, _a in plan}
        contracts = [binding_contract(recipe) for recipe in self.definitions.values()]
        if any(contract != contracts[0] for contract in contracts):
            raise ReplayError('real-workflow-contract-mismatch')
        # The app path/arguments come from the local learned definitions and must
        # also agree with the existing application template, never tool inputs.
        template = validate_recipe(read_json(self.root / 'recipes/cloudmusic.search.template.json'))
        self.application = contracts[0]['application']
        if self.application != template['application']:
            raise ReplayError('configured-application-mismatch')
        self.lab = CapabilityRuntime(lease=300)
        self.preview = LivePreview()
        self.replay = LearnedReplay(self.lab, threading.RLock(),
            self.root / 'recipes/cloudmusic.search.template.json', self.root / 'learned/cloudmusic.search.json',
            lambda info: self.preview.evidence(self.lab.desktop, info), library=self.library)
        self.closed, self.opened = False, False
        self.evidence_dir = self.root / 'reports/mcp-real' / uuid.uuid4().hex

    def catalog(self):
        result = {WORKFLOW: {'id': WORKFLOW, 'kind': 'workflow', 'title': self.workflow['title'],
            'action': 'workflow:' + WORKFLOW, 'definitionSha256': digest(self.workflow),
            'inputSchema': {'type': 'object', 'properties': {'query': {
                'type': 'string', 'minLength': 1, 'maxLength': 200}},
                'required': ['query'], 'additionalProperties': False}}}
        for key, recipe in self.definitions.items():
            operation = recipe['operations'][0]
            result[key] = {'id': key, 'kind': 'capability', 'title': operation['title'],
                'action': 'capability:' + key, 'definitionSha256': digest(recipe),
                'inputSchema': {'type': 'object', 'properties': {p: {
                    'type': 'string', 'minLength': recipe['parameters'][p]['minLength'],
                    'maxLength': recipe['parameters'][p]['maxLength']} for p in operation['inputs']},
                    'required': operation['inputs'], 'additionalProperties': False}}
        for entry in result.values():
            entry.update(mode=self.mode, revision=self.workflow['revision'] if entry['kind'] == 'workflow'
                         else self.definitions[entry['id']]['revision'], automaticRetry=False,
                acceptance='automatic',
                preconditions=['active connection-owned session', 'matching application fingerprint and learned definitions',
                               'owned hidden-desktop window', 'lease and action budget available'],
                effects={'desktop': dict(NO_USER_IMPACT), 'business': 'owned-app-search-field-only',
                         'launchesApplication': entry['id'] in (WORKFLOW, CHILDREN[0]),
                         'writesApplicationState': entry['id'] != CHILDREN[2],
                         'submitsSearch': False, 'playsMedia': False,
                         'applicationNetworkActivity': 'application-managed-not-isolated'},
                verificationScope=SCOPE, realWorldValidated=False)
        return result

    def _check_definitions(self, inputs):
        workflow, _parameters, plan = self.library.plan(inputs)
        if digest(workflow) != digest(self.workflow) or any(
                digest(recipe) != digest(self.definitions[recipe['id']]) for _s, recipe, _a in plan):
            raise ReplayError('registered-definition-changed')
        expected = next(iter(self.definitions.values()))['learning']['applicationFingerprint']
        if fingerprint(self.application['executable']) != expected:
            raise ReplayError('application-version-changed-learning-required')

    def open(self):
        if self.closed or self.opened:
            raise ReplayError('session-already-used')
        self._check_definitions({'query': 'configuration-check'})
        try:
            self.lab.invoke('env.hidden.open', {})
        except (CapabilityError, Blocked) as error:
            raise ReplayError(getattr(error, 'code', str(error))) from error
        self.opened = True

    def guard(self):
        if not self.opened or self.closed:
            raise ReplayError('session-not-open')
        try:
            self.lab._require_open()._assert_open()
        except (CapabilityError, Blocked) as error:
            raise ReplayError(getattr(error, 'code', str(error))) from error
        if self.replay.requires_reset:
            raise ReplayError('session-recovery-required')

    def availability(self, capability_id):
        try:
            self.guard()
        except ReplayError as error:
            return 'unavailable', str(error)
        if self.replay.busy():
            return 'unavailable', 'task-busy'
        if self.lab.actions >= self.lab.max_actions:
            return 'unavailable', 'budget-exhausted'
        if capability_id != WORKFLOW and capability_id != CHILDREN[0] and not self.lab.facts()['ownedAppRunning']:
            return 'unavailable', 'application-not-started'
        if capability_id == CHILDREN[-1] and self.replay.binding is None:
            return 'unavailable', 'binding-required'
        return 'ready', None

    def preflight(self, descriptor, inputs):
        self._check_definitions({'query': inputs.get('query', 'configuration-check')})
        availability, reason = self.availability(descriptor['id'])
        if availability != 'ready':
            raise ReplayError(reason)

    def observation(self):
        self.guard()
        # UIA references stay on the replay executor's COM-owning thread.
        return self.replay.executor.submit(self._observe).result()

    def _observe(self):
        try:
            facts = self.lab.facts()
            value = None
            if facts.get('ownedAppRunning'):
                recipe = self.replay.active_recipe or self.definitions[CHILDREN[0]]
                identity = self.replay._environment(recipe)[2]
                if self.replay.binding:
                    tree, original = self.replay.bound['search']
                    row = live_target(tree, original, recipe['targets']['search'])
                    value = tree.value(row['index'])
            result = {'scope': SCOPE, 'pixels': False, 'value': value,
                      'bound': self.replay.binding is not None,
                      'ownedAppRunning': bool(facts.get('ownedAppRunning')),
                      'actionsUsed': self.lab.actions, 'actionsMax': self.lab.max_actions,
                      'leaseRemainingSeconds': self.lab.desktop.remaining()}
            if facts.get('ownedAppRunning'):
                info, image = self.lab.desktop.capture_frame(allow_unrendered=False)
                if info['hwnd'] != identity['hwnd'] or self.replay._environment(recipe)[2] != identity:
                    raise ReplayError('observation-instance-changed')
                self.evidence_dir.mkdir(parents=True, exist_ok=True)
                path = self.evidence_dir / 'observation.png'
                path.write_bytes(image)
                result['preview'] = {k: info[k] for k in ('sha256', 'width', 'height', 'capturedAt')}
                result['evidencePath'] = str(path)
            return result
        except Exception:
            self.replay.requires_reset = True
            self.replay._drop()
            raise ReplayError('real-observation-failed') from None

    def close(self):
        errors = []
        if not self.closed:
            try:
                self.replay.shutdown()
            except Exception:
                errors.append('binding-release-unconfirmed')
            try:
                result = self.lab.invoke('env.app.close', {})['result']
                if result.get('cleaned') is not True:
                    errors.append('desktop-cleanup-unconfirmed')
            except Exception:
                errors.append('desktop-cleanup-unconfirmed')
            self.preview.clear()
            self.closed = True
        else:
            return copy.deepcopy(self.cleanup)
        self.cleanup = {'closed': not errors, 'scope': 'owned-hidden-desktop-and-processes'}
        if errors:
            self.cleanup['error'] = ';'.join(errors)
        return copy.deepcopy(self.cleanup)
