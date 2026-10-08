"""B4 read-only candidates with synthetic pins/ports only; no native calls."""
import copy
from contextlib import closing
import importlib.util
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('original_fixture', ROOT / 'tests/app-original-process.test.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
Fixture, PROFILE, LaunchFailure = fixtures.Fixture, fixtures.PROFILE, fixtures.LaunchFailure
sys.path.insert(0, str(ROOT / 'spikes/local-workspace'))
from provider_worker import ProviderWorker


class TaskPort:
    def __init__(self):
        self.identity = {'providerId': 'synthetic-provider', 'environmentId': 'synthetic-environment',
                         'sessionId': 'synthetic-task', 'instanceId': 'synthetic-backend', 'inputResourceId': 'synthetic-input'}
        self.prebinding_identity = Mock(side_effect=lambda: copy.deepcopy(self.identity))


class OriginalPrebindingTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        real_stat = os.stat
        patchers = [self.f.patches()[0], patch('app_launch.os.stat', side_effect=lambda path, *args, **kwargs:
            types.SimpleNamespace(st_mtime=50) if path == fixtures.SPEC['executable'] else real_stat(path, *args, **kwargs))]
        for patcher in patchers:
            patcher.start(); self.addCleanup(patcher.stop)
        self.token = self.f.issue()
        self.task = TaskPort()
        self.worker = ProviderWorker('synthetic-unused-directory')
        self.worker.controller = types.SimpleNamespace()
        self.worker.backend_nonce = 'synthetic-incarnation'
        self.worker.backend_instance_id = 'synthetic-backend'
        self.worker.run_id = 'synthetic-run'
        self.worker.windows_session_id = 7
        self.worker.target_id = 'synthetic-target'
        self.admission = Mock(return_value=True)  # Fake port, never native authority
        self.addCleanup(self.f.native.close)

    def prepare(self, **overrides):
        args = {'task_session': self.task, 'producer': self.worker, 'admission': self.admission, **overrides}
        return self.f.native.prepare_original_prebinding(self.token, PROFILE, self.f.context, **args)

    def read(self, handle, **overrides):
        args = {'task_session': self.task, 'producer': self.worker, 'admission': self.admission, **overrides}
        return self.f.native.read_original_prebinding(handle, **args)

    def test_candidate_maps_original_without_second_launch_attach_or_query_handle_and_never_grants(self):
        self.worker.start = Mock(side_effect=AssertionError('second launch'))
        self.worker.identity_facts = Mock(side_effect=AssertionError('OS lookup'))
        count = self.f.enumerations
        handle = self.prepare()
        self.assertIs(type(handle), object)
        result = self.read(handle)
        self.assertEqual(result['version'], 'p8-b-original-prebinding-v1')
        self.assertEqual(result['status'], 'unavailable')
        self.assertEqual(result['blockers'], ['window-lifetime-unavailable', 'same-issuer-producer-unavailable',
                                             'authenticated-admission-channel-unavailable'])
        self.assertEqual(result['original']['process']['createdTicks'], 100)
        self.assertEqual(result['original']['context']['windowsSessionId'], 7)
        self.assertEqual(result['original']['window'], {'hwnd': 20, 'thread': 30})
        self.assertFalse(result['producer']['sameIssuer'])
        self.assertIs(self.prepare(), handle)
        result['original']['process']['pid'] = 999
        result['taskSession']['sessionId'] = 'substitute'
        self.assertEqual(self.read(handle)['original']['process']['pid'], 10)
        self.assertEqual(self.f.enumerations, count); self.assertEqual(len(self.f.pins), 1)
        self.worker.start.assert_not_called(); self.worker.identity_facts.assert_not_called()

    def test_same_strings_in_new_task_worker_or_admission_cannot_replace_exact_ports(self):
        for port in ('task_session', 'producer', 'admission'):
            with self.subTest(port=port):
                # Independent originals/issuers for each terminal branch.
                other = Fixture()
                token = other.issue()
                handle = other.native.prepare_original_prebinding(token, PROFILE, other.context,
                                                                  self.task, self.worker, self.admission)
                replacement = {'task_session': TaskPort(), 'producer': copy.copy(self.worker),
                               'admission': Mock(return_value=True)}[port]
                args = {'task_session': self.task, 'producer': self.worker, 'admission': self.admission, port: replacement}
                with self.assertRaisesRegex(LaunchFailure, 'incarnation-changed'):
                    other.native.read_original_prebinding(handle, **args)
                with self.assertRaisesRegex(LaunchFailure, 'retired'):
                    other.native.read_original_prebinding(handle, self.task, self.worker, self.admission)
                other.native.close()

    def test_other_issuer_and_forged_handle_cannot_resolve(self):
        handle = self.prepare(); other = Fixture()
        with self.assertRaisesRegex(LaunchFailure, 'not-issued'):
            other.native.read_original_prebinding(handle, self.task, self.worker, self.admission)
        with self.assertRaisesRegex(LaunchFailure, 'not-issued'):
            self.read(object())
        other.native.close()

    def test_original_process_exit_and_same_pid_reuse_are_terminal(self):
        handle = self.prepare(); self.f.state['alive'] = False
        with self.assertRaisesRegex(LaunchFailure, 'original-exited'): self.read(handle)
        self.f.state.update(alive=True, ticks=200)
        with self.assertRaisesRegex(LaunchFailure, 'retired'): self.read(handle)
        self.assertEqual(len(self.f.pins), 1)

    def test_destroy_same_hwnd_reuse_gap_and_late_subscription_cannot_rearm_generation(self):
        for interruption in ('destroy-and-reuse', 'event-gap', 'late-subscription'):
            with self.subTest(interruption=interruption):
                other = Fixture(); token = other.issue()
                handle = other.native.prepare_original_prebinding(token, PROFILE, other.context,
                                                                  self.task, self.worker, self.admission)
                generation = other.native.read_original_prebinding(handle, self.task, self.worker, self.admission)['windowGeneration']
                # Only a negative observer notification is supported. No native
                # ordered observer is implemented or claimed by this Fake event.
                other.native.original_processes.invalidate_window(token)
                other.window = 20  # identical HWND/thread/PID after interruption
                with self.assertRaisesRegex(LaunchFailure, 'retired'):
                    other.native.read_original_prebinding(handle, self.task, self.worker, self.admission)
                self.assertEqual(other.native.original_processes.records[token]['windowGeneration'], generation)
                with self.assertRaisesRegex(LaunchFailure, 'retired'): other.issue()
                other.native.close()

    def test_undetected_hwnd_reuse_or_polling_never_becomes_continuity_pass(self):
        handle = self.prepare()
        self.f.window = None; self.f.window = 20  # event entirely between polls
        for _ in range(3):
            self.assertEqual(self.read(handle)['status'], 'unavailable')
            self.assertIn('window-lifetime-unavailable', self.read(handle)['blockers'])

    def test_task_session_fields_and_worker_incarnation_drift_are_terminal(self):
        for target, key in [(self.task.identity, key) for key in self.task.identity] + [
                (self.worker.__dict__, key) for key in ('backend_nonce', 'backend_instance_id', 'run_id', 'windows_session_id', 'target_id', 'stale')]:
            with self.subTest(key=key):
                other = Fixture(); token = other.issue()
                handle = other.native.prepare_original_prebinding(token, PROFILE, other.context, self.task, self.worker, self.admission)
                before = target[key]; target[key] = 'changed'
                with self.assertRaises(LaunchFailure):
                    other.native.read_original_prebinding(handle, self.task, self.worker, self.admission)
                target[key] = before
                with self.assertRaisesRegex(LaunchFailure, 'retired'):
                    other.native.read_original_prebinding(handle, self.task, self.worker, self.admission)
                other.native.close()

    def test_controller_replacement_is_terminal_even_when_restored_without_start_or_stop(self):
        handle = self.prepare(); controller = self.worker.controller
        self.worker.controller = types.SimpleNamespace()
        with self.assertRaisesRegex(Exception, 'controller_changed'): self.read(handle)
        self.worker.controller = controller
        with self.assertRaisesRegex(LaunchFailure, 'retired'): self.read(handle)
        with self.assertRaisesRegex(Exception, 'controller_changed'): self.worker.original_issuer_prebinding_facts()

    def test_issuer_context_change_and_later_reservation_invalidate_candidate(self):
        handle = self.prepare(); self.f.context['instanceId'] = 'new-issuer'
        with self.assertRaises(LaunchFailure): self.read(handle)
        self.f.context['instanceId'] = 'synthetic-helper'
        with self.assertRaisesRegex(LaunchFailure, 'retired'): self.read(handle)

    def test_later_reservation_invalidates_retained_candidate(self):
        handle = self.prepare(); self.f.native.reserve_context()
        with self.assertRaisesRegex(LaunchFailure, 'retired'): self.read(handle)

    def test_committed_denial_before_binding_wins_without_reading_task_or_producer(self):
        # Actual SQLite commit/reopen, all synthetic rows. This Fake port is not
        # the cross-process Host admission channel (which remains unavailable).
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'synthetic-denial.sqlite'
            with closing(sqlite3.connect(path)) as db:
                db.execute('CREATE TABLE denials (profile TEXT, phase TEXT)')
                db.execute('INSERT INTO denials VALUES (?, ?)', ('synthetic-profile', 'denied-pending'))
                db.commit()
            def admission():
                with closing(sqlite3.connect(path)) as db:
                    return not db.execute('SELECT 1 FROM denials WHERE profile=?', ('synthetic-profile',)).fetchone()
            self.worker.original_issuer_prebinding_facts = Mock(side_effect=AssertionError('binding after denial'))
            with self.assertRaisesRegex(LaunchFailure, 'admission-unconfirmed'): self.prepare(admission=admission)
            self.task.prebinding_identity.assert_not_called()
            self.worker.original_issuer_prebinding_facts.assert_not_called()
            self.assertIsNone(self.f.native.original_processes.records[self.token]['prebinding'])
            with self.assertRaisesRegex(LaunchFailure, 'retired'): self.prepare()

    def test_denial_during_preparation_or_later_read_is_terminal(self):
        self.admission.side_effect = [True, False]
        with self.assertRaisesRegex(LaunchFailure, 'admission-unconfirmed'): self.prepare()
        self.admission.side_effect = None
        with self.assertRaisesRegex(LaunchFailure, 'retired'): self.prepare()

    def test_later_denial_and_failed_admission_reads_cannot_restore_candidate(self):
        handle = self.prepare(); self.admission.side_effect = RuntimeError('denial-store-unreadable')
        with self.assertRaisesRegex(RuntimeError, 'store-unreadable'): self.read(handle)
        self.admission.side_effect = None
        with self.assertRaisesRegex(LaunchFailure, 'retired'): self.read(handle)

    def test_ambiguous_admission_and_malformed_task_cannot_create_candidate(self):
        self.admission.return_value = 1  # truthy is not confirmed admission
        with self.assertRaisesRegex(LaunchFailure, 'admission-unconfirmed'): self.prepare()
        self.assertIsNone(self.f.native.original_processes.records[self.token]['prebinding'])
        self.task.prebinding_identity.assert_not_called()

    def test_task_schema_uses_existing_session_tuple_without_accepting_proof_fields(self):
        self.task.identity['windowContinuity'] = 'PASS'
        with self.assertRaisesRegex(LaunchFailure, 'task-identity-unavailable'): self.prepare()
        del self.task.identity['windowContinuity']
        with self.assertRaisesRegex(LaunchFailure, 'retired'): self.prepare()

    def test_reentrant_retirement_during_admission_cannot_publish_candidate(self):
        self.admission.side_effect = lambda: (self.f.native.reserve_context(), True)[1]
        with self.assertRaisesRegex(LaunchFailure, 'retired'): self.prepare()
        self.assertIsNone(self.f.native.original_processes.records[self.token]['prebinding'])

    def test_unknown_close_blocks_all_candidates_without_reopening_original(self):
        handle = self.prepare(); self.f.state['close_failure'] = True
        with self.assertRaisesRegex(LaunchFailure, 'close-unconfirmed'): self.f.native.close()
        with self.assertRaisesRegex(LaunchFailure, 'records-unavailable'): self.read(handle)
        with self.assertRaisesRegex(LaunchFailure, 'records-unavailable'): self.prepare()
        self.assertEqual(len(self.f.pins), 1); self.assertEqual(self.f.pins[0].closes, 1)

    def test_legacy_rpc_cannot_prepare_or_read_candidate(self):
        self.worker.emit = Mock()
        for method in ('prepare_original_prebinding', 'read_original_prebinding', 'original_issuer_prebinding_facts'):
            self.worker.dispatch({'id': 1, 'method': method, 'args': {}})
            self.assertEqual(self.worker.emit.call_args.args[0]['error'], 'unsupported_workspace_operation')
        manager = fixtures.AppLaunchManager(lambda: fixtures.SCOPE, self.f.native)
        with self.assertRaisesRegex(LaunchFailure, 'operation-fields'):
            manager.handle({'scope': fixtures.SCOPE, 'operation': 'prepare_original_prebinding'})


if __name__ == '__main__':
    unittest.main()
