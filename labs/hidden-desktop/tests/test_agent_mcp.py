"""Synthetic task/runtime/MCP integration; no models, native input or private data."""
import io
import json
from pathlib import Path
import queue
import subprocess
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent_runtime import TaskError, TaskRuntime
from mcp_stdio import MAX_MESSAGE_BYTES, McpServer, serve
from synthetic_runtime import SyntheticBackend


LAB = Path(__file__).resolve().parents[1]


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.now = [10.0]
        # Any accidental escape to the real desktop/UIA or network fails the test.
        for target in ('hidden_desktop.NativeDesktopApi', 'uia_client.UiaTree', 'socket.socket'):
            guard = patch(target, side_effect=AssertionError('real boundary reached'))
            guard.start()
            self.addCleanup(guard.stop)
        self.runtime = TaskRuntime(lambda: SyntheticBackend(clock=lambda: self.now[0]))
        self.backend = self.runtime.backend
        self.runtime.open()
        self.addCleanup(lambda: self.runtime.close(wait=True))

    def run_task(self, capability='synthetic.form.submit', inputs=None, request='one'):
        receipt = self.runtime.start(capability, inputs if inputs is not None else {'query': 'Synthetic example'}, request)
        self.backend.replay.executor.submit(lambda: None).result(timeout=3)
        return receipt, self.runtime.status(receipt['jobId'])['job']

    def test_full_chain_reuses_json_executor_and_preserves_manual_acceptance(self):
        listing = self.runtime.list_capabilities()
        self.assertEqual(listing['mode'], 'synthetic')
        self.assertEqual(len(listing['capabilities']), 4)
        description = self.runtime.describe('synthetic.form.submit')['capability']
        self.assertFalse(description['automaticRetry'])
        self.assertEqual(description['acceptance'], 'manual')
        receipt, job = self.run_task()
        self.assertEqual(job['executionStatus'], 'done', job)
        self.assertEqual(job['verification']['status'], 'manual-required')
        self.assertFalse(job['verification']['realWorldValidated'])
        self.assertEqual([step['status'] for step in job['steps']], ['done'] * 3)
        self.assertTrue(any(call['capability'] == 'replay.binding.transfer' for call in job['calls']))
        observation = self.runtime.observation()['observation']
        self.assertEqual(observation['value'], 'Synthetic example')
        self.assertEqual(observation['submitted'], 'Synthetic example')
        self.assertEqual((observation['writes'], observation['clicks'], observation['actionsUsed']), (1, 1, 2))
        self.assertFalse(observation['pixels'])
        self.assertFalse(Path(self.backend.lab.executable).exists())
        text = json.dumps(job)
        for private_field in ('applicationFingerprint', 'hwnd', 'runtimeId', self.backend.temp.name):
            self.assertNotIn(private_field, text)
        cleanup = self.runtime.close()
        self.assertTrue(cleanup['cleanup']['closed'])
        self.assertTrue(all(tree.closed for tree in self.backend.lab.desktop.trees))
        self.assertFalse(Path(self.backend.temp.name).exists())
        self.assertEqual(self.runtime.status(receipt['jobId'])['job'], job)

    def test_sub_capabilities_report_automatic_readback_and_keep_job_history(self):
        first, bound = self.run_task('synthetic.bind', {})
        self.assertEqual(bound['verification']['status'], 'passed')
        _receipt, filled = self.run_task('synthetic.fill', {'query': 'new value'}, request='two')
        self.assertEqual(filled['verifiedValue'], 'new value')
        self.assertEqual(filled['verification']['status'], 'passed')
        self.assertEqual(self.runtime.status(first['jobId'])['job'], bound)

    def test_deduplication_before_and_after_completion_never_repeats_actions(self):
        entered, release = threading.Event(), threading.Event()
        original = self.backend.lab._locate

        def slow(tree, selector):
            entered.set()
            if not release.wait(3):
                raise RuntimeError('synthetic-deadline')
            return original(tree, selector)

        self.backend.lab._locate = slow
        first = self.runtime.start('synthetic.form.submit', {'query': 'value'}, 'same')
        try:
            self.assertTrue(entered.wait(2))
            duplicate = self.runtime.start('synthetic.form.submit', {'query': 'value'}, 'same')
            self.assertEqual(duplicate['jobId'], first['jobId'])
            self.assertTrue(duplicate['deduplicated'])
            progress = self.runtime.status(first['jobId'])['job']
            self.assertEqual(progress['executionStatus'], 'running')
            self.assertEqual(progress['currentCall'], 'learn.locate.structured')
            for action in (lambda: self.runtime.start('synthetic.bind', {}, 'other'),
                           self.runtime.observation, self.runtime.close):
                with self.assertRaisesRegex(TaskError, 'task-busy'):
                    action()
        finally:
            release.set()
        self.backend.replay.executor.submit(lambda: None).result(timeout=3)
        duplicate = self.runtime.start('synthetic.form.submit', {'query': 'value'}, 'same')
        self.assertTrue(duplicate['deduplicated'])
        self.assertEqual(self.backend.lab.desktop.clicks, 1)
        with self.assertRaisesRegex(TaskError, 'request-id-conflict'):
            self.runtime.start('synthetic.form.submit', {'query': 'changed'}, 'same')

    def test_invalid_inputs_and_paths_cannot_reach_dispatch(self):
        for inputs in ({}, {'query': ''}, {'query': '   '}, {'query': 'x' * 201}, {'query': True}, {'query': '\ud800'},
                       {'query': 'ok', 'path': 'C:/private.exe'}, {'query': 'ok', 'allowInput': 'true'}):
            with self.subTest(inputs=inputs), self.assertRaises(TaskError):
                self.runtime.start('synthetic.form.submit', inputs, 'request')
        for identifier in ('../outside', 'learn', 'reset', 'env.app.launch', 'act.click'):
            with self.assertRaises(TaskError):
                self.runtime.start(identifier, {}, 'request')
        self.assertIsNone(self.backend.replay.job)
        self.assertEqual(self.backend.lab.actions, 0)

    def test_literal_parameters_are_not_evaluated(self):
        literal = '${not_code}; $(nothing) " quoted 世界'
        _receipt, job = self.run_task(inputs={'query': literal})
        self.assertEqual(job['executionStatus'], 'done')
        self.assertEqual(self.runtime.observation()['observation']['submitted'], literal)

    def test_tampered_dependency_fails_preflight_before_any_input(self):
        path = self.backend.library.capabilities_dir / 'synthetic.submit.json'
        recipe = json.loads(path.read_text(encoding='utf-8'))
        recipe['operations'][0]['description'] = 'changed'
        path.write_text(json.dumps(recipe), encoding='utf-8')
        with self.assertRaisesRegex(TaskError, 'definition-preflight-failed'):
            self.run_task()
        with self.assertRaisesRegex(TaskError, 'definition-preflight-failed'):
            self.runtime.start('synthetic.submit', {'query': 'value'}, 'direct')
        self.assertEqual(self.runtime.jobs, {})
        self.assertEqual(self.backend.lab.actions, 0)

    def test_availability_reflects_prerequisites_and_current_lease(self):
        entries = {entry['id']: entry for entry in self.runtime.list_capabilities()['capabilities']}
        self.assertEqual(entries['synthetic.fill']['reason'], 'binding-required')
        self.assertEqual(entries['synthetic.form.submit']['availability'], 'ready')
        self.run_task('synthetic.bind', {})
        self.assertEqual(self.runtime.describe('synthetic.fill')['capability']['availability'], 'ready')
        self.now[0] += 301
        self.assertEqual(self.runtime.describe('synthetic.fill')['capability']['reason'], 'lease-expired')

    def test_unknown_effect_stops_and_same_request_never_retries(self):
        self.backend.lab.desktop.fail_click = True
        receipt, job = self.run_task()
        self.assertEqual(job['executionStatus'], 'failed')
        self.assertEqual(job['effectStatus'], 'unknown')
        self.assertEqual(job['error'], 'dispatch-effect-unknown')
        self.assertEqual(job['verification']['status'], 'failed')
        self.assertTrue(job['requiresRecovery'])
        self.assertEqual(self.backend.lab.desktop.clicks, 1)
        self.assertEqual(self.backend.lab.actions, 2)
        self.assertEqual(self.runtime.start('synthetic.form.submit', {'query': 'Synthetic example'}, 'one')['jobId'], receipt['jobId'])
        with self.assertRaisesRegex(TaskError, 'session-recovery-required'):
            self.runtime.start('synthetic.form.submit', {'query': 'Synthetic example'}, 'two')
        self.assertEqual(self.backend.lab.desktop.clicks, 1)

    def test_failed_independent_readback_stops_before_submit(self):
        self.backend.lab.desktop.wrong_value = True
        _receipt, job = self.run_task()
        self.assertEqual(job['error'], 'value-verification-failed')
        self.assertEqual([step['status'] for step in job['steps']], ['done', 'failed', 'pending'])
        self.assertEqual(self.backend.lab.desktop.clicks, 0)
        self.assertEqual(self.backend.lab.actions, 1)

    def test_budget_expiry_and_stale_identity_never_fallback(self):
        self.backend.lab.max_actions = 0
        _receipt, job = self.run_task()
        self.assertEqual(job['error'], 'budget-exhausted')
        self.assertEqual(self.backend.lab.desktop.writes, 0)
        self.assertEqual(self.backend.lab.desktop.clicks, 0)

    def test_lease_is_bounded_and_never_silently_renewed(self):
        self.now[0] += 301
        with self.assertRaisesRegex(Exception, 'lease-expired'):
            self.runtime.start('synthetic.form.submit', {'query': 'value'}, 'one')
        with self.assertRaisesRegex(Exception, 'lease-expired'):
            self.runtime.observation()
        self.assertEqual(self.backend.lab.actions, 0)
        self.assertTrue(self.runtime.close()['cleanup']['closed'])

    def test_stale_bound_target_stops_without_input(self):
        self.run_task('synthetic.bind', {})
        self.backend.lab.desktop.stale = True
        _receipt, job = self.run_task('synthetic.fill', {'query': 'value'}, 'two')
        self.assertEqual(job['executionStatus'], 'failed')
        self.assertEqual(self.backend.lab.desktop.writes, 0)

    def test_history_cap_does_not_evict_deduplication_keys(self):
        self.runtime.MAX_TASKS = 2
        first, _job = self.run_task('synthetic.bind', {})
        self.run_task('synthetic.bind', {}, 'two')
        with self.assertRaisesRegex(TaskError, 'task-history-full'):
            self.runtime.start('synthetic.bind', {}, 'three')
        self.assertEqual(self.runtime.start('synthetic.bind', {}, 'one')['jobId'], first['jobId'])

    def test_sessions_do_not_share_jobs_state_or_request_keys(self):
        other = TaskRuntime(SyntheticBackend)
        other.open()
        self.addCleanup(lambda: other.close(wait=True))
        receipt, _job = self.run_task()
        with self.assertRaisesRegex(TaskError, 'job-not-found'):
            other.status(receipt['jobId'])
        self.assertIsNone(other.observation()['observation']['submitted'])
        self.assertNotEqual(self.runtime.session_id, other.session_id)

    def test_cleanup_failure_is_not_success_and_closed_session_cannot_restart(self):
        self.backend.lab.desktop.fail_cleanup = True
        result = self.runtime.close()
        self.assertFalse(result['cleanup']['closed'])
        self.assertEqual(result['cleanup']['error'], 'cleanup-unconfirmed')
        with self.assertRaisesRegex(TaskError, 'session-closed'):
            self.runtime.start('synthetic.bind', {}, 'one')
        self.assertEqual(self.runtime.close(), result)
        with self.assertRaisesRegex(TaskError, 'cleanup-unconfirmed'):
            self.runtime.open()

    def test_connection_idle_does_not_consume_lease_and_open_never_renews(self):
        runtime = TaskRuntime(lambda: SyntheticBackend(clock=lambda: self.now[0]))
        self.addCleanup(lambda: runtime.close(wait=True))
        self.assertIsNone(runtime.session_id)
        self.assertIsNone(runtime.backend.lab.desktop.deadline)
        self.now[0] += 1000
        self.assertEqual(runtime.describe('synthetic.bind')['capability']['reason'], 'session-not-open')
        with self.assertRaisesRegex(TaskError, 'session-closed'):
            runtime.start('synthetic.bind', {}, 'before-open')
        opened = runtime.open()
        deadline = runtime.backend.lab.desktop.deadline
        self.assertEqual(deadline, self.now[0] + 300)
        self.now[0] += 100
        self.assertEqual(runtime.open()['sessionId'], opened['sessionId'])
        self.assertFalse(runtime.open()['opened'])
        self.assertEqual(runtime.backend.lab.desktop.deadline, deadline)

    def test_two_explicit_sessions_keep_old_jobs_and_deduplication(self):
        first, first_job = self.run_task(inputs={'query': 'first task'})
        old_backend = self.backend
        self.assertTrue(self.runtime.close()['cleanup']['closed'])
        opened = self.runtime.open()
        self.assertNotEqual(opened['sessionId'], first['sessionId'])
        self.assertTrue(all(tree.closed for tree in old_backend.lab.desktop.trees))
        self.assertEqual(self.runtime.status(first['jobId'])['job'], first_job)
        duplicate = self.runtime.start('synthetic.form.submit', {'query': 'first task'}, 'one')
        self.assertEqual(duplicate['jobId'], first['jobId'])
        self.assertEqual(self.runtime.backend.lab.desktop.clicks, 0)
        self.backend = self.runtime.backend
        second, second_job = self.run_task(inputs={'query': 'second task'}, request='two')
        self.assertNotEqual(first['jobId'], second['jobId'])
        self.assertEqual(second_job['verification']['status'], 'manual-required')
        self.assertEqual(self.runtime.observation()['observation']['submitted'], 'second task')
        self.assertEqual(self.backend.lab.desktop.clicks, 1)


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.runtime = TaskRuntime(SyntheticBackend)
        self.runtime.open()
        self.addCleanup(lambda: self.runtime.close(wait=True))
        self.server = McpServer(self.runtime)

    def rpc(self, method, params=None, identifier=1):
        return self.server.dispatch({'jsonrpc': '2.0', 'id': identifier, 'method': method, 'params': params or {}})

    def initialize(self, version='2025-11-25'):
        response = self.rpc('initialize', {'protocolVersion': version, 'capabilities': {},
                                          'clientInfo': {'name': 'synthetic-test', 'version': '1'}})
        self.server.dispatch({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        return response

    def test_handshake_discovery_tools_and_serialized_structured_results(self):
        self.assertIn('error', self.rpc('tools/list'))
        self.assertEqual(self.initialize('2025-06-18')['result']['protocolVersion'], '2025-06-18')
        self.assertEqual(self.rpc('ping')['result'], {})
        tools = self.rpc('tools/list')['result']['tools']
        self.assertEqual(len(tools), 7)
        self.assertTrue(all(t['inputSchema']['additionalProperties'] is False for t in tools))
        result = self.rpc('tools/call', {'name': 'capabilities_list'})['result']
        self.assertEqual(json.loads(result['content'][0]['text']), result['structuredContent'])
        self.assertFalse(result['isError'])
        self.assertIn('error', self.initialize())

    def test_unknown_version_negotiates_a_supported_version(self):
        self.assertEqual(self.initialize('unknown')['result']['protocolVersion'], '2025-11-25')

    def test_notifications_do_not_dispatch_actions_or_get_responses(self):
        self.initialize()
        response = self.server.dispatch({'jsonrpc': '2.0', 'method': 'tools/call',
            'params': {'name': 'task_start', 'arguments': {'capabilityId': 'synthetic.bind', 'inputs': {}, 'requestId': 'one'}}})
        self.assertIsNone(response)
        self.assertEqual(self.runtime.jobs, {})

    def test_protocol_and_tool_errors_have_different_envelopes(self):
        self.initialize()
        self.assertEqual(self.rpc('unknown')['error']['code'], -32601)
        self.assertEqual(self.rpc('tools/call', {'name': 'unknown'})['error']['code'], -32602)
        result = self.rpc('tools/call', {'name': 'task_start', 'arguments': {
            'capabilityId': 'act.click', 'inputs': {}, 'requestId': 'one'}})['result']
        self.assertTrue(result['isError'])
        self.assertEqual(result['structuredContent']['error']['code'], 'unknown-capability')
        result = self.rpc('tools/call', {'name': 'session_close', 'arguments': {'allowLive': 'true'}})['result']
        self.assertTrue(result['isError'])
        self.assertFalse(self.runtime.closed)

    def test_close_cleanup_failure_is_a_tool_error_not_a_success(self):
        self.initialize()
        self.runtime.backend.lab.desktop.fail_cleanup = True
        response = self.rpc('tools/call', {'name': 'session_close'})['result']
        self.assertTrue(response['isError'])
        self.assertEqual(response['structuredContent']['error']['code'], 'cleanup-unconfirmed')
        self.assertFalse(response['structuredContent']['cleanup']['closed'])

    def test_request_metadata_does_not_grant_authority(self):
        self.initialize()
        self.assertIn('tools', self.rpc('tools/list', {'_meta': {'progressToken': 'test'}})['result'])
        response = self.rpc('tools/call', {'name': 'task_start', 'arguments': {
            'capabilityId': 'act.click', 'inputs': {}, 'requestId': 'one'}, '_meta': {'allowLive': True}})['result']
        self.assertTrue(response['isError'])
        self.assertEqual(self.runtime.jobs, {})

    def test_invalid_jsonrpc_shapes_fail_without_side_effects(self):
        for message in ([], {}, {'jsonrpc': '2.0', 'id': True, 'method': 'initialize'},
                        {'jsonrpc': '2.0', 'id': None, 'method': 'initialize'}):
            self.assertEqual(self.server.dispatch(message)['error']['code'], -32600)
        self.assertEqual(self.runtime.jobs, {})

    def test_framing_rejects_bad_utf8_duplicate_keys_nan_and_oversize(self):
        for data in (b'not-json\n', b'\xff\n', b'{"id":1,"id":2}\n', b'{"value":NaN}\n', b'[' * 1200 + b'\n'):
            output = io.BytesIO()
            self.assertEqual(serve(self.server, io.BytesIO(data), output), 0)
            self.assertEqual(json.loads(output.getvalue())['error']['code'], -32700)
        output = io.BytesIO()
        self.assertEqual(serve(self.server, io.BytesIO(b'x' * (MAX_MESSAGE_BYTES + 1)), output), 1)
        self.assertEqual(len(output.getvalue().splitlines()), 1)


class StdioProcessTests(unittest.TestCase):
    def test_eof_without_explicit_close_drains_task_and_releases_temp_files(self):
        program = '''import io, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from agent_runtime import TaskRuntime
from synthetic_runtime import SyntheticBackend
from mcp_stdio import McpServer, serve
runtime = TaskRuntime(SyntheticBackend)
runtime.open()
backend = runtime.backend
runtime.start('synthetic.form.submit', {'query': 'eof example'}, 'eof')
assert serve(McpServer(runtime), io.BytesIO(), io.BytesIO()) == 0
closed = runtime.close(wait=True)
assert closed['cleanup']['closed']
assert backend.lab.desktop.submitted == 'eof example'
assert all(tree.closed for tree in backend.lab.desktop.trees)
assert not Path(backend.temp.name).exists()
'''
        completed = subprocess.run([sys.executable, '-c', program, str(LAB)], capture_output=True, timeout=5)
        self.assertEqual(completed.returncode, 0, completed.stderr.decode('utf-8', errors='replace'))
        self.assertEqual(completed.stdout, b'')

    def test_real_stdio_process_full_chain_and_eof_cleanup(self):
        process = subprocess.Popen([sys.executable, str(LAB / 'mcp_stdio.py'), '--fake'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=LAB)

        def cleanup_process():
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()

        self.addCleanup(cleanup_process)
        responses = queue.Queue()

        def receive():
            for line in process.stdout:
                responses.put(line)

        reader = threading.Thread(target=receive, daemon=True)
        reader.start()
        counter = 0

        def rpc(method, params=None):
            nonlocal counter
            counter += 1
            process.stdin.write((json.dumps({'jsonrpc': '2.0', 'id': counter, 'method': method,
                                             'params': params or {}}, ensure_ascii=False) + '\n').encode('utf-8'))
            process.stdin.flush()
            response = json.loads(responses.get(timeout=5))
            self.assertEqual(response['id'], counter)
            self.assertNotIn('error', response, response)
            return response['result']

        def call(name, arguments=None):
            response = rpc('tools/call', {'name': name, 'arguments': arguments or {}})
            self.assertFalse(response['isError'], response)
            return response['structuredContent']

        rpc('initialize', {'protocolVersion': '2025-11-25', 'capabilities': {},
                           'clientInfo': {'name': 'independent-stdio-client', 'version': '1'}})
        process.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
        process.stdin.flush()
        self.assertEqual(len(rpc('tools/list')['tools']), 7)
        self.assertEqual(call('capabilities_list')['mode'], 'synthetic')
        self.assertEqual(call('capability_describe', {'capabilityId': 'synthetic.form.submit'})['capability']['acceptance'], 'manual')
        first_session = call('session_open')['sessionId']
        arguments = {'capabilityId': 'synthetic.form.submit', 'inputs': {'query': '合成 example'}, 'requestId': 'stdio-one'}
        receipt = call('task_start', arguments)
        self.assertEqual(call('task_start', arguments)['jobId'], receipt['jobId'])
        for _ in range(100):
            job = call('task_status', {'jobId': receipt['jobId']})['job']
            if job['executionStatus'] != 'running':
                break
            threading.Event().wait(.01)
        self.assertEqual(job['executionStatus'], 'done')
        self.assertEqual(job['verification']['status'], 'manual-required')
        observation = call('observation_get')['observation']
        self.assertEqual(observation['submitted'], '合成 example')
        self.assertEqual((observation['writes'], observation['clicks']), (1, 1))
        self.assertTrue(call('session_close')['cleanup']['closed'])
        second_session = call('session_open')['sessionId']
        self.assertNotEqual(second_session, first_session)
        arguments.update(inputs={'query': 'second synthetic task'}, requestId='stdio-two')
        second = call('task_start', arguments)
        for _ in range(100):
            second_job = call('task_status', {'jobId': second['jobId']})['job']
            if second_job['executionStatus'] != 'running':
                break
            threading.Event().wait(.01)
        self.assertEqual(second_job['executionStatus'], 'done')
        self.assertEqual(second_job['verification']['status'], 'manual-required')
        self.assertEqual(call('observation_get')['observation']['submitted'], 'second synthetic task')
        self.assertEqual(call('task_status', {'jobId': receipt['jobId']})['job']['sessionId'], first_session)
        self.assertTrue(call('session_close')['cleanup']['closed'])
        process.stdin.close()
        self.assertEqual(process.wait(timeout=5), 0)
        reader.join(timeout=2)
        self.assertEqual(process.stderr.read(), b'')
        self.assertTrue(responses.empty())

    def test_real_mode_requires_explicit_matching_profile_before_backend_initialization(self):
        for arguments in (['--real'], ['--profile', 'cloudmusic-fill-search'],
                          ['--profile', 'cloudmusic-playback'], ['--fake','--profile','cloudmusic-playback'],
                          ['--fake', '--real', '--profile', 'cloudmusic-fill-search']):
            with self.subTest(arguments=arguments):
                process = subprocess.run([sys.executable, str(LAB / 'mcp_stdio.py'), *arguments],
                                         capture_output=True, timeout=5)
                self.assertNotEqual(process.returncode, 0)
                self.assertEqual(process.stdout, b'')


if __name__ == '__main__':
    unittest.main()
