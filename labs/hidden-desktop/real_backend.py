"""Opt-in CloudMusic adapter over the existing owned-desktop JSON executor.

Construction/discovery reads definitions only. Native resources are created at
session_open. Explicit profiles expose pinned fill, search or playback workflows.
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
from replay_observation import matches
from skill_composition import SkillLibrary, binding_contract, digest, read_json, substitute


WORKFLOW = 'cloudmusic.fill-search'
CHILDREN = ('cloudmusic.launch', 'cloudmusic.prepareSearch',
            'cloudmusic.locateSearch', 'cloudmusic.fillSearch')
SCOPE = 'real-owned-window-input-readback'
SEARCH_WORKFLOW = 'cloudmusic.search'
READ_RESULTS = 'cloudmusic.readSearchResults'
SEARCH_CHILDREN = (*CHILDREN, 'cloudmusic.submitSearch', READ_RESULTS)
SEARCH_SCOPE = 'real-owned-window-search-results'
PLAY_WORKFLOW = 'cloudmusic.open-and-play'
PLAY_CHILDREN = (*CHILDREN, 'cloudmusic.submitSearch', 'cloudmusic.openSong', 'cloudmusic.playSong')
PLAY_SCOPE = 'real-owned-window-playback-state'


class PlaybackLibrary(SkillLibrary):
    """Reuse the original seven JSON children; keep final business acceptance manual."""
    def __init__(self, root):
        super().__init__(root / 'recipes/workflows/cloudmusic.playback.json', root / 'learned/capabilities',
                         validate_recipe, require_local=True)

    def capability(self, capability_id):
        recipe = super().capability(capability_id)
        if capability_id == 'cloudmusic.openSong':
            # Search may report a first match; playback requires a unique match
            # in the existing declared region before dispatching the double click.
            steps = recipe['operations'][0]['steps']
            steps[0]['readyMatch'].pop('selectionPolicy', None)
            steps[1]['match'].pop('selectionPolicy', None)
        if capability_id == 'cloudmusic.playSong':
            recipe['operations'][0]['acceptance'] = 'manual'
            validate_recipe(recipe, True)
        return recipe


class SearchLibrary(SkillLibrary):
    """Reuse the pinned openSong readiness predicate, with read-only steps only."""
    def __init__(self, root):
        super().__init__(root / 'recipes/workflows/cloudmusic.search.json', root / 'learned/capabilities',
                         validate_recipe, require_local=True)
        self.reader = read_json(root / 'recipes/cloudmusic.read-search-results.json')
        if (not isinstance(self.reader, dict) or set(self.reader) != {'schemaVersion', 'id', 'title', 'source'}
                or self.reader['schemaVersion'] != 1 or self.reader['id'] != READ_RESULTS
                or not isinstance(self.reader['title'], str) or not 1 <= len(self.reader['title']) <= 200
                or not isinstance(self.reader['source'], dict)
                or set(self.reader['source']) != {'capability', 'definitionSha256'}):
            raise ReplayError('invalid-result-reader-definition')

    def capability(self, capability_id):
        if capability_id != READ_RESULTS:
            return super().capability(capability_id)
        source = super().capability(self.reader['source']['capability'])
        if source['id'] != 'cloudmusic.openSong' or digest(source) != self.reader['source']['definitionSha256']:
            raise ReplayError('result-reader-source-changed')
        ready = copy.deepcopy(source['operations'][0]['steps'][0])
        if ready.get('op') != 'observe_local' or not ready.get('newPageBindings') or not ready.get('readyMatch'):
            raise ReplayError('result-reader-predicate-changed')
        recipe = copy.deepcopy(source)
        recipe.update(id=READ_RESULTS, revision=1)
        recipe['operations'] = [{'id': READ_RESULTS, 'title': self.reader['title'],
            'description': 'Read the existing declared result predicate without opening a song.',
            'inputs': ['song', 'artist'], 'acceptance': 'manual',
            'completion': 'Matched search result read; search submission acceptance remains manual.',
            'steps': [ready, {'op': 'assert_rows', 'match': copy.deepcopy(ready['readyMatch'])}, {'op': 'capture'}]}]
        return validate_recipe(recipe, True)


class RealBackend:
    mode = 'real'

    def __init__(self, root=None, search=False, playback=False):
        if search and playback:
            raise ReplayError('conflicting-real-profiles')
        self.root = Path(root) if root else Path(__file__).resolve().parent
        self.search_enabled = search
        self.playback_enabled = playback
        self.workflow_id, self.children = ((PLAY_WORKFLOW, PLAY_CHILDREN) if playback else
                                          (SEARCH_WORKFLOW, SEARCH_CHILDREN) if search else (WORKFLOW, CHILDREN))
        self.scope = PLAY_SCOPE if playback else SEARCH_SCOPE if search else SCOPE
        self.library = PlaybackLibrary(self.root) if playback else SearchLibrary(self.root) if search else SkillLibrary(
            self.root / 'recipes/workflows/cloudmusic.fill-search.json',
            self.root / 'learned/capabilities', validate_recipe, require_local=True)
        self.workflow, _parameters, plan = self.library.plan(self._inspection_inputs())
        if self.workflow['id'] != self.workflow_id or tuple(r['id'] for _s, r, _a in plan) != self.children:
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

    def _inspection_inputs(self):
        return {'song': 'configuration-check', 'artist': 'configuration-check'} if self.search_enabled or self.playback_enabled else {'query': 'configuration-check'}

    def catalog(self):
        parameters = self.workflow['parameters']
        result = {self.workflow_id: {'id': self.workflow_id, 'kind': 'workflow', 'title': self.workflow['title'],
            'action': 'workflow:' + self.workflow_id, 'definitionSha256': digest(self.workflow),
            'inputSchema': {'type': 'object', 'properties': {p: {
                'type': 'string', 'minLength': 1, 'maxLength': spec['maxLength']} for p, spec in parameters.items()},
                'required': list(parameters), 'additionalProperties': False}}}
        for key, recipe in self.definitions.items():
            if self.playback_enabled:
                continue  # Playback exposes only the complete ordered workflow.
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
                acceptance='manual' if entry['id'] in (PLAY_WORKFLOW, SEARCH_WORKFLOW, 'cloudmusic.submitSearch', READ_RESULTS) else 'automatic',
                preconditions=['active connection-owned session', 'matching application fingerprint and learned definitions',
                               'owned hidden-desktop window', 'lease and action budget available'],
                effects={'desktop': dict(NO_USER_IMPACT), 'business': 'owned-app-playback' if self.playback_enabled else 'owned-app-search' if self.search_enabled else 'owned-app-search-field-only',
                         'launchesApplication': entry['id'] in (self.workflow_id, CHILDREN[0]),
                         'writesApplicationState': entry['id'] not in (CHILDREN[2], READ_RESULTS),
                         'submitsSearch': entry['id'] in (PLAY_WORKFLOW, SEARCH_WORKFLOW, 'cloudmusic.submitSearch'),
                         'playsMedia': self.playback_enabled,
                         'applicationNetworkActivity': 'application-managed-not-isolated'},
                verificationScope=self.scope, realWorldValidated=False)
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
        self._check_definitions(self._inspection_inputs())
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
        if capability_id != self.workflow_id and capability_id != CHILDREN[0] and not self.lab.facts()['ownedAppRunning']:
            return 'unavailable', 'application-not-started'
        if capability_id in (CHILDREN[-1], 'cloudmusic.submitSearch') and self.replay.binding is None:
            return 'unavailable', 'binding-required'
        if capability_id == 'cloudmusic.submitSearch' and 'verifiedQuery' not in self.replay.values:
            return 'unavailable', 'verified-input-required'
        if capability_id == READ_RESULTS and not self._result_inputs():
            return 'unavailable', 'confirmed-submission-required'
        return 'ready', None

    def preflight(self, descriptor, inputs):
        self._check_definitions(inputs if descriptor['kind'] == 'workflow' else self._inspection_inputs())
        availability, reason = self.availability(descriptor['id'])
        if availability != 'ready':
            raise ReplayError(reason)
        if descriptor['id'] == READ_RESULTS:
            previous = self._result_inputs()
            query = previous.get('submittedQuery') or ' '.join(previous[k] for k in ('song', 'artist'))
            if query != ' '.join(inputs[k] for k in ('song', 'artist')):
                raise ReplayError('result-query-does-not-match-submission')

    def observation(self):
        self.guard()
        # UIA references stay on the replay executor's COM-owning thread.
        return self.replay.executor.submit(self._observe).result()

    def _result_inputs(self):
        if not self.search_enabled or not self.replay.job or self.replay.job['status'] != 'done':
            return None
        job = self.replay.job
        if job['action'] == 'workflow:' + SEARCH_WORKFLOW:
            return job['inputs']
        if job['action'] == 'capability:' + READ_RESULTS:
            return job['inputs']
        # A separate submit is also eligible for an explicit read task, but its
        # song/artist criteria must be supplied by that task, not invented here.
        if job['action'] == 'capability:cloudmusic.submitSearch':
            value = job.get('output', {}).get('verifiedValue')
            return {'submittedQuery': value} if isinstance(value, str) else None
        return None

    def _read_results(self, inputs):
        recipe = self.definitions[READ_RESULTS]
        spec = substitute(recipe['operations'][0]['steps'][0]['readyMatch'], inputs)
        rows = self._read_matching_rows(recipe, spec)
        return {'rows': rows, 'selection': 'first-visible-match-in-declared-region',
                'completeResultList': False, 'globalUnique': None}

    def _read_matching_rows(self, recipe, spec, controls=False):
        tree, proof = self.replay._local_query(recipe, spec)
        # Read actual current names, never return the search criteria as evidence.
        rows, live_rows = [], []
        for row in proof['matches'] + proof['relatedMatches']:
            current = copy.deepcopy(row)
            current['name'] = tree._string(tree.elements[row['index']], 23)
            if controls:
                current['autoId'] = tree._string(tree.elements[row['index']], 29)
                current['role'] = tree._integer(tree.elements[row['index']], 21)
            tree.prove_target(current)
            live_rows.append(current)
            rows.append({key: current[key] for key in (('role', 'name', 'autoId') if controls else ('role', 'name'))})
        if not matches(live_rows, spec, tree.desktop.api.window_rect(tree.hwnd)):
            raise ReplayError('current-observation-changed')
        return rows

    def _playback_inputs(self):
        job = self.replay.job
        if (self.playback_enabled and job and job['status'] == 'done'
                and job['action'] == 'workflow:' + PLAY_WORKFLOW):
            return job['inputs']
        return None

    def _read_playback(self, inputs):
        recipe = self.definitions['cloudmusic.playSong']
        spec = substitute(recipe['operations'][0]['steps'][0]['readyMatch'], inputs)
        rows = self._read_matching_rows(recipe, spec, controls=True)
        return {'rows': rows, 'state': 'playing', 'stateEvidence': 'current-pause-button',
                'audioAudibilityVerified': False}

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
            result = {'scope': self.scope, 'pixels': False, 'value': value,
                      'bound': self.replay.binding is not None,
                      'ownedAppRunning': bool(facts.get('ownedAppRunning')),
                      'actionsUsed': self.lab.actions, 'actionsMax': self.lab.max_actions,
                      'leaseRemainingSeconds': self.lab.desktop.remaining()}
            criteria = self._result_inputs()
            if criteria and 'song' in criteria:
                result['results'] = self._read_results(criteria)
            playback = self._playback_inputs()
            if playback:
                result['playback'] = self._read_playback(playback)
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
