"""Explicit bench ownership and HTTP routing, using temporary synthetic resources."""
from contextlib import ExitStack
from http.client import HTTPConnection
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB))
from hidden_desktop_lab.bootstrap import create_application
from hidden_desktop_lab.paths import LabPaths
from hidden_desktop_lab.transports import http


class FakeLibrary:
    def __init__(self, *args, **kwargs):
        pass

    def summary(self):
        return {'workflow': {'id': 'synthetic.flow', 'title': 'Synthetic flow'},
                'capabilities': [], 'contracts': []}


class FakeReplay:
    def __init__(self, lab, lock, template, learned, publish, **kwargs):
        self.lab, self.lock = lab, lock
        self.template, self.learned = template, learned
        self.publish = publish
        self.active = False
        self.invalidations = self.shutdowns = 0
        self.started = []

    def summary(self):
        return {'learningRequired': True, 'bound': False, 'values': {},
                'requiresReset': False, 'busy': self.active}

    def busy(self):
        return self.active

    def start(self, action, inputs):
        self.started.append((action, inputs))
        return 'synthetic-job'

    def invalidate(self):
        self.invalidations += 1

    def shutdown(self):
        self.shutdowns += 1


class BenchApplicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='lab-bench-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.paths = LabPaths(self.root)
        self.manifest = dict(schemaVersion=1, template='synthetic/template.json',
                             learned='learned/synthetic.json', workflow='recipes/synthetic.json',
                             capabilities='learned/capabilities', paths='learned/paths.json',
                             record='reports/synthetic.json',
                             page={'route': '/workflows/synthetic', 'file': 'workflow.html'},
                             additionalWorkflows=[dict(key='second', route='/workflows/second',
                                 aliases=['/manual-flow'], workflow='recipes/second.json',
                                 capabilities='recipes/capabilities', profiles='recipes/profiles',
                                 record='reports/second.json')])
        self.write_manifest()
        presets = {'schemaVersion': 1, 'presets': {'synthetic': {
            'label': 'Synthetic fixture', 'app': 'custom',
            'path': str(self.root / 'synthetic.exe'), 'args': ''}}}
        (self.root / 'app-launch-presets.json').write_text(json.dumps(presets), encoding='utf-8')
        for name in ('ui.html', 'workflow.html', 'workflow.js', 'learned-skills.js', 'live-preview.js'):
            (self.root / name).write_text('synthetic page fixture', encoding='utf-8')
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        for target in ('hidden_desktop.NativeDesktopApi.__init__', 'uia_client.UiaTree.__init__'):
            self.stack.enter_context(patch(target, side_effect=AssertionError('native boundary reached')))

    def write_manifest(self):
        (self.root / 'experiment.json').write_text(json.dumps(self.manifest), encoding='utf-8')

    def assemble_fake(self):
        with patch('hidden_desktop_lab.bootstrap.ContractLibrary', FakeLibrary), \
                patch('hidden_desktop_lab.bootstrap.InstructionLibrary', FakeLibrary), \
                patch('hidden_desktop_lab.bootstrap.LearnedReplay', FakeReplay):
            app = create_application(self.paths)
        self.addCleanup(app.close)
        return app

    def test_explicit_assembly_owns_separate_executors_and_resolves_paths_from_lab_root(self):
        self.manifest['additionalWorkflows'] = []
        self.write_manifest()
        first = create_application(self.paths, lease=30)
        self.addCleanup(first.close)
        second = create_application(self.paths)
        self.addCleanup(second.close)
        self.assertIsNot(first.lab, second.lab)
        self.assertIsNot(first.lock, second.lock)
        self.assertIsNot(first.replay.executor, second.replay.executor)
        self.assertEqual(first.lab.lease, 30)
        self.assertEqual(second.lab.lease, 300)
        self.assertEqual(first.lab.max_actions, 256)
        self.assertIsNone(first.lab.desktop)
        self.assertEqual(first.replay.template_path, self.root / 'synthetic/template.json')
        self.assertEqual(first.library.contracts_path, self.paths.capability_contracts)
        first.close()
        first.close()
        self.assertTrue(first.replay.executor._shutdown)
        self.assertFalse(second.replay.executor._shutdown)

    def test_additional_profile_failure_releases_already_created_executor(self):
        created = []
        from learned_replay import LearnedReplay
        def record(*args, **kwargs):
            replay = LearnedReplay(*args, **kwargs)
            created.append(replay)
            return replay
        with patch('hidden_desktop_lab.bootstrap.LearnedReplay', side_effect=record), \
                patch('hidden_desktop_lab.bootstrap.InstructionLibrary', side_effect=ValueError('invalid-profile')):
            with self.assertRaisesRegex(ValueError, 'invalid-profile'):
                create_application(self.paths)
        self.assertEqual(len(created), 1)
        self.assertTrue(created[0].executor._shutdown)

    def test_shutdown_uses_each_replay_owner_before_desktop_cleanup(self):
        app = self.assemble_fake()
        events = []
        for key, replay in app.replays.items():
            replay.shutdown = lambda key=key: events.append(key)
        app.lab.desktop = SimpleNamespace(context={'instanceId': 'synthetic'},
                                          close=lambda: events.append('desktop'))
        with patch('builtins.print'):
            app.close()
        self.assertEqual(events, ['default', 'second', 'desktop'])

    def test_cleanup_failure_remains_unconfirmed_and_does_not_repeat_executor_shutdown(self):
        from hidden_desktop import CleanupUnconfirmed
        app = self.assemble_fake()
        close = unittest.mock.Mock(side_effect=CleanupUnconfirmed(['synthetic-residual']))
        app.lab.desktop = SimpleNamespace(context={'instanceId': 'synthetic'}, close=close)
        with patch('builtins.print') as output:
            app.close()
        self.assertFalse(app._closed)
        self.assertIn('synthetic-residual', output.call_args.args[0])
        close.side_effect = None
        with patch('builtins.print'):
            app.close()
        self.assertTrue(app._closed)
        self.assertEqual(close.call_count, 2)
        self.assertTrue(all(replay.shutdowns == 1 for replay in app.replays.values()))

    def start_server(self, app):
        server = http.create_server(app, 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def close():
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
        self.addCleanup(close)
        return server

    def request(self, server, route, body=None, headers=None):
        connection = HTTPConnection('127.0.0.1', server.server_port, timeout=3)
        try:
            options = {} if body is None else {'Content-Type': 'application/json', 'X-Lab': '1'}
            options.update(headers or {})
            connection.request('GET' if body is None else 'POST', route,
                               body=None if body is None else json.dumps(body), headers=options)
            response = connection.getresponse()
            content = response.read()
            return response.status, json.loads(content) if 'application/json' in response.getheader('Content-Type', '') else content
        finally:
            connection.close()

    def test_http_catalog_routes_and_aliases_use_only_the_attached_application(self):
        first, second = self.assemble_fake(), self.assemble_fake()
        first_server, second_server = self.start_server(first), self.start_server(second)
        status, data = self.request(first_server, '/api/state')
        self.assertEqual(status, 200)
        self.assertEqual(set(data['state']), {'facts', 'actions', 'lease', 'capabilities', 'log', 'last',
            'lastPreview', 'previewSession', 'previewTransport', 'learned', 'appLaunchPresets', 'manualFlow', 'workflowPage'})
        self.assertEqual(data['state']['actions'], {'used': 0, 'max': 256})
        for route in ('/', '/workflows/synthetic', '/workflows/second', '/manual-flow', '/workflow.js',
                      '/live-preview.js', '/learned-skills.js', '/api/composition'):
            with self.subTest(route=route):
                self.assertEqual(self.request(first_server, route)[0], 200)
        self.assertEqual(self.request(first_server, '/api/workflows')[1]['pages'], {
            '/workflows/synthetic': 'default', '/workflows/second': 'second', '/manual-flow': 'second'})
        self.assertEqual(self.request(first_server, '/api/state?profile=missing')[0], 404)
        self.assertEqual(self.request(first_server, '/api/state', headers={'Host': 'untrusted.invalid'})[0], 403)
        self.assertEqual(self.request(first_server, '/api/invoke', {}, headers={'X-Lab': '0'})[0], 403)
        self.assertEqual(self.request(first_server, '/api/invoke', {'id': 'missing'})[1]['error']['code'], 'unsupported-capability')
        self.assertIsNone(self.request(second_server, '/api/state')[1]['state']['last'])

    def test_cross_profile_busy_and_invalidation_guards_are_preserved(self):
        app = self.assemble_fake()
        server = self.start_server(app)
        default, other = app.replays['default'], app.replays['second']
        other.active = True
        self.assertEqual(self.request(server, '/api/learned/start', {'action': 'synthetic.step'})[0], 409)
        self.assertEqual(self.request(server, '/api/invoke', {'id': 'control.budget.consume'})[0], 409)
        self.assertEqual(default.started, [])
        other.active = False
        status, data = self.request(server, '/api/learned/start', {'action': 'synthetic.step', 'inputs': {'text': 'test'}})
        self.assertEqual((status, data['jobId']), (200, 'synthetic-job'))
        self.assertEqual(default.started, [('synthetic.step', {'text': 'test'})])
        self.assertEqual(other.invalidations, 1)
        with patch.object(app.lab, 'invoke', return_value={'result': {}, 'elapsedMs': 0}):
            self.assertEqual(self.request(server, '/api/invoke', {'id': 'act.click'})[0], 200)
        self.assertEqual((default.invalidations, other.invalidations), (1, 2))

    def test_live_preview_does_not_wait_for_the_execution_lock(self):
        app = self.assemble_fake()
        server = self.start_server(app)
        with app.lock, patch.object(app.preview, 'capture', return_value=({'instanceId': 'synthetic'}, b'fake-png')):
            status, data = self.request(server, '/api/preview/live', {})
        self.assertEqual((status, data), (200, b'fake-png'))

    def test_entry_point_validates_before_assembly_and_closes_after_bind_failure(self):
        with patch.object(sys, 'argv', ['server.py', '--lease', '0']), patch.object(http, 'create_application') as create:
            with self.assertRaises(SystemExit):
                http.main()
            create.assert_not_called()
        app = self.assemble_fake()
        with patch.object(sys, 'argv', ['server.py', '--no-browser']), \
                patch.object(http, 'create_application', return_value=app), \
                patch.object(http, 'free_port', return_value=8790), \
                patch.object(http, 'create_server', side_effect=OSError('bind-failed')):
            with self.assertRaisesRegex(OSError, 'bind-failed'):
                http.main()
        self.assertTrue(all(replay.shutdowns == 1 for replay in app.replays.values()))


if __name__ == '__main__':
    unittest.main()
