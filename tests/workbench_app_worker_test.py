import copy
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import subprocess
import sys
import unittest

spec = importlib.util.spec_from_file_location('workbench_app_worker', Path(__file__).resolve().parents[1] / 'src/desktop-provider/workbench_app_worker.py')
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)


class StdioTests(unittest.TestCase):
    def test_chinese_profile_uses_utf8_even_with_windows_gbk_default(self):
        # Exercise the actual dispatcher with a fake owner; never loads Win32 APIs.
        script = '''import importlib.util, threading
spec = importlib.util.spec_from_file_location('worker', %r)
w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
class FakeOwner:
    def __init__(self, *args):
        self.lock = threading.RLock(); self.watch_stop = threading.Event()
        self.watcher = threading.Thread(target=lambda: None); self.watcher.start()
        self.fence = type('Fence', (), {'db': type('Database', (), {'close': lambda self: None})()})()
    def instances(self, profile): return [profile['displayName']]
    def close(self): return {'cleaned': True}
w.OwnedApp = FakeOwner
w.main()
''' % str(spec.origin)
        import os
        environment = {**os.environ, 'PYTHONIOENCODING': 'gbk'}
        requests = [dict(id=1, method='init', fields=dict(config={}, scope={}, registry='synthetic')),
                    dict(id=2, method='instances', fields=dict(profile=dict(displayName='网易云音乐'))),
                    dict(id=3, method='close')]
        result = subprocess.run([sys.executable, '-c', script], input=('\n'.join(json.dumps(item, ensure_ascii=False) for item in requests) + '\n').encode('utf-8'),
                                capture_output=True, timeout=5, env=environment)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
        replies = [json.loads(line) for line in result.stdout.decode('utf-8').splitlines()]
        self.assertEqual(replies[1]['result'], ['网易云音乐'])
        self.assertEqual(replies[2]['result'], {'cleaned': True})


class RegistryFenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.path = Path(self.temp.name) / 'synthetic.sqlite'
        self.scope = {'providerId': 'workbench-apps', 'environmentId': 'local-workspace:apps', 'installationScopeId': 'synthetic'}
        self.profile = dict(scope=self.scope, appBindingId='app', installationId='install', applicationId='synthetic', profileRevision=1,
                            profileDigest='digest', identity={'fingerprint': 'synthetic'}, launchSpec={'kind': 'exe'},
                            validity='current', availability='available', trust='confirmed', confirmations=[{'profileRevision': 1, 'profileDigest': 'digest'}])
        self.db = sqlite3.connect(self.path)
        self.db.executescript('''CREATE TABLE private_app_denial_store(version INTEGER); INSERT INTO private_app_denial_store VALUES(1);
            CREATE TABLE private_app_denials(provider_id TEXT,environment_id TEXT,app_binding_id TEXT,installation_id TEXT,application_id TEXT);
            CREATE TABLE app_environments(provider_id TEXT,environment_id TEXT,installation_scope_id TEXT,scope_revision INTEGER);
            CREATE TABLE environment_apps(provider_id TEXT,environment_id TEXT,app_binding_id TEXT,installation_scope_id TEXT,scope_revision INTEGER,data_json TEXT);''')
        self.db.execute('INSERT INTO app_environments VALUES(?,?,?,1)', ('workbench-apps', 'local-workspace:apps', 'synthetic'))
        self.db.execute('INSERT INTO environment_apps VALUES(?,?,?,?,1,?)', ('workbench-apps', 'local-workspace:apps', 'app', 'synthetic', json.dumps(self.profile)))
        self.db.commit(); self.fence = worker.RegistryFence(self.path, self.scope)

    def tearDown(self):
        self.fence.db.close(); self.db.close(); self.temp.cleanup()

    def test_only_current_confirmed_profile_enters_effect_and_always_releases_lock(self):
        self.assertEqual(self.fence.run(self.profile, lambda: 'effect'), 'effect')
        self.assertFalse(self.fence.db.in_transaction)
        with self.assertRaises(RuntimeError): self.fence.run(self.profile, lambda: (_ for _ in ()).throw(RuntimeError('synthetic')))
        self.assertFalse(self.fence.db.in_transaction)

    def test_denial_scope_generation_identity_and_confirmation_changes_block_before_effect(self):
        mutations = [dict(trust='discovered'), dict(validity='stale'), dict(availability='unavailable'), dict(confirmations=[]),
                     dict(profileDigest='changed'), dict(identity={'fingerprint': 'changed'}), dict(launchSpec={'kind': 'package'})]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                current = {**copy.deepcopy(self.profile), **mutation}
                self.db.execute('UPDATE environment_apps SET data_json=?', (json.dumps(current),)); self.db.commit()
                with self.assertRaises(ValueError): self.fence.run(self.profile, lambda: self.fail('effect must not run'))
        self.db.execute('UPDATE environment_apps SET data_json=?', (json.dumps(self.profile),))
        self.db.execute('INSERT INTO private_app_denials VALUES(?,?,?,?,?)', ('workbench-apps', 'local-workspace:apps', 'app', 'install', 'synthetic')); self.db.commit()
        with self.assertRaises(ValueError): self.fence.run(self.profile, lambda: self.fail('denied effect'))
        self.db.execute('DELETE FROM private_app_denials'); self.db.execute('UPDATE app_environments SET scope_revision=2'); self.db.commit()
        with self.assertRaises(ValueError): self.fence.run(self.profile, lambda: self.fail('old generation effect'))


if __name__ == '__main__': unittest.main()
