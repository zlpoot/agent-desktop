"""Synthetic JEV contract/HTTP checks. No keys, model service or desktop API."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jev_server import (Bench, BenchError, CASES, FAULTS, Handler, MAX_CALLS,
                        MAX_RESPONSE, NoRedirect, load_config, live_transport, validate_answer)


class JevTests(unittest.TestCase):
    def test_fake_all_cases_and_connection(self):
        bench = Bench()
        with patch('jev_server.live_transport', side_effect=AssertionError('network forbidden')):
            self.assertTrue(bench.run({'operation': 'models'})['result']['modelFound'])
            for fixture in CASES:
                with self.subTest(fixture=fixture['id']):
                    result = bench.run({'operation': 'systemone', 'caseId': fixture['id']})
                    self.assertEqual(result['mode'], 'fake')
                    self.assertTrue(result['result']['matchesExpected'])
                    self.assertEqual(result['result']['choice'], fixture['expected'])

    def test_faults_fail_closed_and_consume_budget(self):
        for fault in FAULTS[1:]:
            bench = Bench()
            with self.subTest(fault=fault), self.assertRaises(BenchError):
                bench.run({'operation': 'systemone', 'fault': fault})
            self.assertEqual(bench.used, 1)

    def test_bounded_requests_no_retry_or_parallel_call(self):
        bench = Bench()
        for _ in range(MAX_CALLS):
            bench.run({'operation': 'models'})
        with self.assertRaisesRegex(BenchError, 'budget-exhausted'):
            bench.run({'operation': 'models'})
        self.assertEqual(bench.used, MAX_CALLS)
        bench = Bench()
        with bench.lock, self.assertRaisesRegex(BenchError, 'request-in-flight'):
            bench.run({'operation': 'models'})
        self.assertEqual(bench.used, 0)

    def test_live_shape_and_no_actions(self):
        calls = []
        def transport(config, operation, body):
            calls.append((config, operation, body))
            return {'answers': {'q0': {'type': 'choice', 'choice': 'unknown', 'confidence': .9}}}
        bench = Bench({'base': 'https://synthetic.invalid', 'key': 'synthetic-key'}, transport)
        result = bench.run({'operation': 'systemone', 'caseId': 'semantic-pending'})
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], 'systemone')
        self.assertEqual(calls[0][2]['model'], 'jev')
        self.assertEqual(set(calls[0][2]), {'model', 'state', 'questions'})
        self.assertTrue(result['result']['matchesExpected'])
        self.assertNotIn('synthetic-key', json.dumps(bench.state()) + json.dumps(result))
        with self.assertRaisesRegex(BenchError, 'fake-fault-only'):
            bench.run({'operation': 'models', 'fault': 'timeout'})

    def test_accepted_wrong_answer_is_not_test_pass(self):
        result = validate_answer({'answers': {'q0': {'type': 'choice', 'choice': 'fail', 'confidence': .9}}}, CASES[1])
        self.assertFalse(result['matchesExpected'])

    def test_untrusted_answers_and_usage(self):
        good = {'answers': {'q0': {'type': 'choice', 'choice': 'action_0', 'confidence': .9}},
                'usage': {'input_tokens': 2, 'output_tokens': 1, 'extra': 'must-not-leak'}}
        self.assertNotIn('extra', validate_answer(good, CASES[0])['usage'])
        for confidence in (True, float('nan'), float('inf'), -.1, 1.1, None, '0.9'):
            raw = copy.deepcopy(good)
            raw['answers']['q0']['confidence'] = confidence
            with self.subTest(confidence=confidence), self.assertRaises(BenchError):
                validate_answer(raw, CASES[0])
        for raw in ([], {}, {'answers': []}, {'answers': {'q0': [], 'extra': {}}}):
            with self.subTest(raw=raw), self.assertRaises(BenchError):
                validate_answer(raw, CASES[0])
        good['usage']['input_tokens'] = True
        self.assertIsNone(validate_answer(good, CASES[0])['usage'])

    def test_invalid_requests_do_not_consume_budget(self):
        bench = Bench()
        for payload in (None, [], {}, {'operation': 'act.click'}, {'operation': 'models', 'caseId': []},
                        {'operation': 'models', 'apiKey': 'forbidden'}, {'operation': 'models', 'fault': 'oops'}):
            with self.subTest(payload=payload), self.assertRaises(BenchError):
                bench.run(payload)
        self.assertEqual(bench.used, 0)

    def test_config_matches_ad_without_reading_private_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.env.local').write_text("COMPUTER_USE_API_KEY='synthetic-file-key'\nJEV_BASE_URL=https://ignored.invalid\n")
            config = load_config({'JEV_BASE_URL': 'https://synthetic.test/v1/'}, root)
            self.assertEqual(config, {'base': 'https://synthetic.test', 'key': 'synthetic-file-key'})
            config = load_config({'JEV_BASE_URL': 'http://127.0.0.1:9876', 'COMPUTER_USE_API_KEY': 'synthetic-env-key'}, root)
            self.assertEqual(config['key'], 'synthetic-env-key')
            for endpoint in ('', 'file:///tmp/model', 'https://user:pw@synthetic.invalid',
                             'https://synthetic.invalid/?key=secret', 'https://synthetic.invalid/#secret'):
                with self.subTest(endpoint=endpoint), self.assertRaises(BenchError):
                    load_config({'JEV_BASE_URL': endpoint}, root)
            with self.assertRaises(BenchError):
                load_config({'JEV_BASE_URL': 'https://synthetic.test', 'COMPUTER_USE_API_KEY': 'YOUR_API_KEY'}, root)

    def test_root_dotenv_priority_and_placeholders(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.env').write_text('JEV_BASE_URL="https://synthetic.test/v1"\n'
                                      'COMPUTER_USE_API_KEY=synthetic-dotenv-key\nUNRELATED=do-not-import\n')
            (root / '.env.local').write_text('COMPUTER_USE_API_KEY=synthetic-fallback-key\n')
            config = load_config({}, root)
            self.assertEqual(config, {'base': 'https://synthetic.test', 'key': 'synthetic-dotenv-key'})
            config = load_config({'JEV_BASE_URL': 'https://override.test', 'COMPUTER_USE_API_KEY': 'synthetic-env-key'}, root)
            self.assertEqual(config, {'base': 'https://override.test', 'key': 'synthetic-env-key'})
            (root / '.env').write_text('JEV_BASE_URL=https://jev.example.invalid/v1\nCOMPUTER_USE_API_KEY=YOUR_API_KEY\n')
            with patch('jev_server.live_transport', side_effect=AssertionError('network forbidden')):
                with self.assertRaisesRegex(BenchError, 'demo'):
                    load_config({}, root)

    def test_live_transport_bounded_body_no_redirect_no_retry(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, size):
                self.size = size
                return b'x' * size
        response = Response()
        with patch('jev_server.build_opener') as build:
            build.return_value.open.return_value = response
            with self.assertRaisesRegex(BenchError, 'response-too-large'):
                live_transport({'base': 'https://synthetic.invalid', 'key': 'synthetic'}, 'models', None)
            self.assertIsInstance(build.call_args.args[0], NoRedirect)
            self.assertEqual(build.return_value.open.call_count, 1)
            self.assertEqual(response.size, MAX_RESPONSE + 1)
        self.assertIsNone(NoRedirect().redirect_request(None, None, None, None))


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.server.bench = Bench()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, method, path, body=None, headers=None):
        connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = (response.status, response.read().decode())
        connection.close()
        return result

    def test_page_and_public_state(self):
        status, page = self.request('GET', '/jev')
        self.assertEqual(status, 200)
        self.assertIn('JEV 独立测试台', page)
        status, body = self.request('GET', '/api/jev/state')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['state']['mode'], 'fake')

    def test_write_protection_and_invalid_body(self):
        for headers in ({}, {'X-Lab': '1', 'Origin': 'https://third-party.invalid'},
                        {'X-Lab': '1', 'Host': 'evil.invalid'}):
            status, _ = self.request('POST', '/api/jev/run', '{}', headers)
            self.assertEqual(status, 403)
        for body in ('{', '[]', 'x' * 8193):
            status, _ = self.request('POST', '/api/jev/run', body, {'X-Lab': '1'})
            self.assertEqual(status, 400)

    def test_no_desktop_routes_and_successful_run(self):
        status, _ = self.request('POST', '/api/invoke', '{}', {'X-Lab': '1'})
        self.assertEqual(status, 404)
        status, body = self.request('POST', '/api/jev/run', '{"operation":"systemone"}', {'X-Lab': '1'})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)['record']['result']['matchesExpected'])


if __name__ == '__main__':
    unittest.main()
