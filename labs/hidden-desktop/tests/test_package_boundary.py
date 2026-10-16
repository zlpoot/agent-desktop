"""Package imports and public contracts stay passive and compatible."""
import ast
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest

LAB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB))


class PackageBoundaryTests(unittest.TestCase):
    def test_imports_do_not_read_configuration_or_start_resources(self):
        script = '''
from unittest.mock import patch
from contextlib import ExitStack
import hidden_desktop, uia_client
with ExitStack() as guards:
    for target in ('pathlib.Path.read_text', 'pathlib.Path.read_bytes',
                   'socket.socket', 'threading.Thread.start',
                   'concurrent.futures.ThreadPoolExecutor.__init__',
                   'hidden_desktop.NativeDesktopApi.__init__', 'uia_client.UiaTree.__init__'):
        guards.enter_context(patch(target, side_effect=AssertionError('import side effect: ' + target)))
    import hidden_desktop_lab, hidden_desktop_lab.bootstrap
    import hidden_desktop_lab.transports.http
    import server, agent_runtime, experiment_config, mcp_stdio
    assert not hasattr(server, 'LAB')
'''
        result = subprocess.run([sys.executable, '-c', script], cwd=LAB,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '')

    def test_legacy_imports_expose_the_same_objects(self):
        import agent_runtime
        import experiment_config
        import replay_observation
        import uia_client
        from hidden_desktop_lab.contracts import experiment, matching, uia
        from hidden_desktop_lab.tasks import service
        self.assertIs(agent_runtime.TaskRuntime, service.TaskRuntime)
        self.assertIs(agent_runtime.TaskError, service.TaskError)
        self.assertIs(experiment_config.load_experiment, experiment.load_experiment)
        self.assertIs(uia_client.UiaError, uia.UiaError)
        self.assertIs(uia_client.ROLE_NAMES, uia.ROLE_NAMES)
        self.assertIs(replay_observation.validate_match, matching.validate_match)

    def test_contracts_and_native_imports_do_not_point_back_to_replay(self):
        banned = {'uia_client', 'replay_observation', 'local_replay', 'learned_replay',
                  'capabilities', 'server', 'agent_runtime'}
        sources = list((LAB / 'hidden_desktop_lab/contracts').glob('*.py'))
        sources += [LAB / 'uia_client.py', LAB / 'uia_identity.py']
        for path in sources:
            imports = []
            for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'))):
                if isinstance(node, ast.ImportFrom):
                    imports.append(node.module)
                elif isinstance(node, ast.Import):
                    imports.extend(alias.name for alias in node.names)
            with self.subTest(path=path.name):
                self.assertFalse(set(imports) & banned)

    def test_public_catalog_errors_and_mcp_schemas_match_the_committed_baseline(self):
        from capabilities import CAPABILITIES, ERROR_CATALOG
        from mcp_stdio import tools_for_mode
        values = {'capabilities': CAPABILITIES, 'errors': ERROR_CATALOG,
                  'mcp.synthetic': tools_for_mode('synthetic'),
                  'mcp.fill': tools_for_mode('real'),
                  'mcp.search': tools_for_mode('real', search=True),
                  'mcp.playback': tools_for_mode('real', playback=True)}
        expected = json.loads((LAB / 'tests/fixtures/public-contract-hashes.json').read_text(encoding='utf-8'))
        for key, value in values.items():
            actual = hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                               separators=(',', ':')).encode('utf-8')).hexdigest()
            with self.subTest(contract=key):
                self.assertEqual(actual, expected[key])


if __name__ == '__main__':
    unittest.main()
