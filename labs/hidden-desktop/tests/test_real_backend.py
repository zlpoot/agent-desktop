"""Real adapter checks with generated definitions and fake native boundaries only."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent_runtime import TaskRuntime, TaskError
from hidden_desktop import png_rgb
from learned_replay import LearnedReplay
from mcp_stdio import McpServer
from real_backend import RealBackend, CHILDREN, WORKFLOW, SCOPE
from replay_contract import ReplayError, fingerprint
from skill_composition import digest
from test_local_replay import PROFILE


class FakeNativeLab:
    def __init__(self, executable):
        self.actions, self.max_actions, self.opened, self.running = 0, 256, False, False
        self.value, self.expired, self.fail_cleanup, self.stale = '', False, False, False
        self.executable = executable
        self.desktop = SimpleNamespace(api=SimpleNamespace(
            window_class=lambda h: 'SyntheticWindow', capture_dpi=lambda: None,
            window_rect=lambda h: [0, 0, 1600, 1000]),
            remaining=lambda: 0 if self.expired else 300, _assert_open=self.guard,
            capture_frame=lambda **k: ({'sha256': 'a'*64, 'width': 1, 'height': 1, 'hwnd': 123,
                                      'capturedAt': 'synthetic'}, png_rgb(1, 1, b'\xff\0\0')))

    def guard(self):
        if not self.opened: raise ReplayError('session-not-open')
        if self.expired: raise ReplayError('lease-expired')

    def _require_open(self):
        self.guard()
        return self.desktop

    def facts(self): return {'ownedAppRunning': self.running}
    def _target_window(self): return self.desktop, 123

    def _do_verify_target_identity(self, args):
        return {'ok': True, 'alive': True, 'image': self.executable, 'pid': 7, 'session': 5,
                'instanceId': 'fake-owned', 'desktopName': 'synthetic'}

    def invoke(self, name, args):
        if name == 'env.hidden.open': self.opened = True; result = {}
        elif name == 'env.app.launch': self.running = True; result = {'pid': 7}
        elif name == 'env.identity.probe': result = {'hiddenDesktopOpen': self.opened}
        elif name == 'env.app.close':
            self.running = self.opened = False
            if self.fail_cleanup: raise ReplayError('cleanup-unconfirmed')
            result = {'cleaned': True}
        elif name == 'observe.window.enumerate':
            result = {'items': [{'owned': True, 'root': True, 'hwnd': 123, 'className': 'SyntheticWindow'}]}
        elif name == 'locate.window': result = {'target': 123}
        else: raise AssertionError('Unexpected capability: ' + name)
        return {'result': result}


class FakeTree:
    def __init__(self, desktop, hwnd, lab):
        self.desktop, self.hwnd, self.lab = desktop, hwnd, lab
        self.owner = threading.get_ident()
        self.elements = [0, 1]
        self.closed = False

    def guard(self):
        assert self.owner == threading.get_ident()
        assert not self.closed
        self.lab.guard()
        if self.lab.stale: raise ReplayError('bound-target-changed')

    def local_rows(self, region, nodes, depth):
        self.guard()
        return [{'index': i, 'role': 50004 if i == 0 else 50000,
                 'name': self.lab.value if i == 0 else 'search', 'autoId': '', 'className': '',
                 'enabled': True, 'offscreen': False, 'native': 0, 'runtimeId': [i],
                 'rect': [400+i*120, 20, 500+i*120, 40]} for i in (0, 1)]

    def prove_target(self, row): self.guard(); return {'identityRebound': True}
    def _string(self, element, slot): self.guard(); return self.lab.value if element == 0 else 'search'
    def _integer(self, element, slot): self.guard(); return 0
    def value(self, index): self.guard(); return self.lab.value
    def set_value(self, index, value): self.guard(); self.lab.value = value
    def close(self): assert self.owner == threading.get_ident(); self.closed = True


class RealAdapterTests(unittest.TestCase):
    def setUp(self):
        for target in ('hidden_desktop.NativeDesktopApi', 'socket.socket'):
            blocker = patch(target, side_effect=AssertionError('native escape'))
            blocker.start(); self.addCleanup(blocker.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for folder in ('recipes/workflows', 'learned/capabilities'):
            (self.root / folder).mkdir(parents=True)
        executable = self.root / 'synthetic.exe'
        executable.write_bytes(b'synthetic non-executable fixture')
        template = json.loads((Path(__file__).parent / 'fixtures/replay.template.json').read_text(encoding='utf-8'))
        template['application']['executable'] = str(executable)
        template['targets'] = {k: {**v, 'probeRegion': [.2, 0, .6, .1]} for k, v in template['targets'].items()}
        template['localReplay'] = copy.deepcopy(PROFILE)
        template['replayPolicy']['binding'] = 'local-probe-once-per-predicate-and-instance'
        template['replayPolicy']['onStaleTarget'] = 'require-learning'
        self.write('recipes/cloudmusic.search.template.json', template)
        learned = {'validation': 'targets-and-patterns-only', 'applicationFingerprint': fingerprint(executable),
                   'targets': {k: {'role': 50004 if k == 'search' else 50000,
                       'roleName': 'Edit' if k == 'search' else 'Button',
                       'name': '' if k == 'search' else 'search', 'autoId': '', 'className': ''}
                       for k in template['targets']}}
        operations = [
            {'inputs': [], 'steps': [{'op': 'ensure_app'}]},
            {'inputs': [], 'steps': [{'op': 'observe_local'}]},
            {'inputs': [], 'steps': [{'op': 'bind'}]},
            {'inputs': ['query'], 'steps': [{'op': 'set_value', 'target': 'search', 'parameter': 'query'},
                                          {'op': 'assert_value', 'target': 'search', 'parameter': 'query'}]}]
        workflow = {'schemaVersion': 1, 'kind': 'workflow', 'id': WORKFLOW, 'revision': 1,
                    'title': 'Synthetic fixture', 'automaticRetry': False, 'onFailure': 'stop',
                    'parameters': {'query': {'type': 'string', 'maxLength': 200}}, 'steps': []}
        for key, operation in zip(CHILDREN, operations):
            operation.update(id=key, title=key, description='synthetic fixture')
            if key == CHILDREN[1]:
                operation['steps'] = [{'op': 'observe_local'}, {'op': 'assert_rows',
                    'match': {'role': 50004, 'anyName': True, 'region': [.2, 0, .6, .1]}}]
            recipe = {**template, 'kind': 'learned-capability', 'id': key, 'revision': 1,
                      'operations': [operation], 'learning': learned}
            self.write('learned/capabilities/'+key+'.json', recipe)
            workflow['steps'].append({'id': key, 'capability': key, 'revision': 1,
                'definitionSha256': digest(recipe), 'inputs': {p: {'input': p} for p in operation['inputs']}})
        self.write('recipes/workflows/cloudmusic.fill-search.json', workflow)
        self.lab = FakeNativeLab(str(executable))
        def replay(*args, **kwargs):
            kwargs['tree_factory'] = lambda d, h: FakeTree(d, h, self.lab)
            runner = LearnedReplay(*args, **kwargs)
            runner._prepare_local_window = lambda *args, **kwargs: None  # Startup wait is tested in the existing executor suite.
            return runner
        with patch('real_backend.CapabilityRuntime', return_value=self.lab), patch('real_backend.LearnedReplay', side_effect=replay):
            self.backend = RealBackend(self.root)
        self.runtime = TaskRuntime(lambda: self.backend)
        self.addCleanup(lambda: self.runtime.close(wait=True))

    def write(self, name, value):
        (self.root / name).write_text(json.dumps(value), encoding='utf-8')

    def run_task(self):
        self.runtime.open()
        receipt = self.runtime.start(WORKFLOW, {'query': '接入测试'}, 'one')
        self.backend.replay.executor.submit(lambda: None).result(timeout=5)
        return self.runtime.status(receipt['jobId'])['job']

    def test_full_workflow_and_fresh_observation_stay_on_executor_thread(self):
        self.assertFalse(self.lab.opened)  # Construction and discovery create no desktop.
        self.assertEqual(len(self.runtime.list_capabilities()['capabilities']), 5)
        job = self.run_task()
        self.assertEqual(job['executionStatus'], 'done', job)
        self.assertEqual(job['verification']['scope'], SCOPE)
        self.assertFalse(job['verification']['realWorldValidated'])
        self.assertEqual([s['status'] for s in job['steps']], ['done']*4)
        before = copy.deepcopy(job)
        self.lab.value = 'fresh value'
        observed = self.runtime.observation()['observation']
        self.assertEqual(observed['value'], 'fresh value')
        self.assertTrue(Path(observed['evidencePath']).is_file())
        self.assertEqual(self.runtime.status(job['jobId'])['job'], before)  # Observation cannot rewrite job history.
        self.assertTrue(self.runtime.close()['cleanup']['closed'])
        self.assertFalse(self.lab.running)

    def test_expired_or_stale_target_stops_without_replacement_or_retry(self):
        self.assertEqual(self.run_task()['executionStatus'], 'done')
        self.lab.stale = True
        with self.assertRaisesRegex(ReplayError, 'real-observation-failed'):
            self.runtime.observation()
        with self.assertRaisesRegex(TaskError, 'session-recovery-required'):
            self.runtime.start(WORKFLOW, {'query': 'retry'}, 'two')
        self.assertEqual(len(self.runtime.jobs), 1)

    def test_definition_or_binary_changes_fail_before_native_open(self):
        Path(self.lab.executable).write_bytes(b'changed')
        with self.assertRaisesRegex(ReplayError, 'application-version-changed'):
            self.runtime.open()
        self.assertFalse(self.lab.opened)

    def test_cleanup_failure_remains_failed_and_blocks_reopen(self):
        self.runtime.open(); self.lab.fail_cleanup = True
        self.assertFalse(self.runtime.close()['cleanup']['closed'])
        with self.assertRaisesRegex(TaskError, 'cleanup-unconfirmed'):
            self.runtime.open()

    def test_real_schema_and_catalog_cannot_submit_or_play(self):
        server = McpServer(self.runtime)
        names = {e['id'] for e in self.runtime.list_capabilities()['capabilities']}
        self.assertEqual(names, {WORKFLOW, *CHILDREN})
        for entry in server.tools:
            self.assertEqual(entry['outputSchema']['properties']['mode'], {'const': 'real'})
        observation = server.call_tool('session_open', {})
        self.assertTrue(observation['structuredContent']['ok'])
        with self.assertRaises(TaskError):
            self.runtime.start('cloudmusic.submitSearch', {'query': 'x'}, 'unauthorized')

    def test_lease_expiry_prevents_a_new_task(self):
        self.runtime.open(); self.lab.expired = True
        with self.assertRaisesRegex(ReplayError, 'lease-expired'):
            self.runtime.start(WORKFLOW, {'query': 'x'}, 'expired')
        self.assertEqual(self.runtime.jobs, {})

    def test_observation_rejects_another_owned_window_capture(self):
        self.assertEqual(self.run_task()['executionStatus'], 'done')
        capture = self.lab.desktop.capture_frame
        self.lab.desktop.capture_frame = lambda **k: ({**capture(**k)[0], 'hwnd': 456}, capture(**k)[1])
        with self.assertRaisesRegex(ReplayError, 'real-observation-failed'):
            self.runtime.observation()
        self.assertTrue(self.backend.replay.requires_reset)


if __name__ == '__main__':
    unittest.main()
