"""Synthetic native identity contracts; no DLLs, app, Desktop or input."""
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'spikes/local-workspace'))
from win32 import Api, Blocked, C
spec = importlib.util.spec_from_file_location('bench_diagnostics', ROOT / 'src/desktop-provider/testbench_worker.py')
diagnostics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostics)


class WindowMembershipContracts(unittest.TestCase):
    def setUp(self):
        self.error = 0
        for name, fn in [('get_last_error', lambda: self.error), ('set_last_error', self.set_error)]:
            mock = patch.object(C, name, side_effect=fn, create=True)
            mock.start(); self.addCleanup(mock.stop)
        self.state = {'root': 100, 'windows': [100], 'enumOk': True, 'enumError': 0,
            'pid': 77, 'tid': 88, 'job': True, 'desktop': 'AgentD0_synthetic', 'lookups': [], 'closed': []}
        state = self.state
        self.api = Api.__new__(Api)
        self.api.owned_job_name = 'synthetic-job'
        self.api.assert_default = lambda: None
        self.api.session = lambda pid: 9
        self.api.name = lambda handle, source: state['desktop']
        def owner(hwnd, pid): pid._obj.value = state['pid']; return state['tid']
        def thread(tid):
            state['lookups'].append(tid)
            if tid != 44: self.fail('foreign thread Desktop query must never be used as identity proof')
            return 11
        def member(process, job, flag): flag._obj.value = state['job']; return True
        def enumerate_windows(desktop, callback, context):
            self.assertEqual(desktop, 11)
            for hwnd in state['windows']:
                if not callback(hwnd, context): return False
            self.error = state['enumError']
            return state['enumOk']
        self.api.u = SimpleNamespace(GetWindowThreadProcessId=owner, IsWindow=lambda hwnd: True,
            GetThreadDesktop=thread, GetAncestor=lambda hwnd, flags: state['root'],
            EnumDesktopWindows=enumerate_windows, CloseDesktop=lambda handle: self.fail('borrowed Desktop handle'))
        self.api.k = SimpleNamespace(GetCurrentThreadId=lambda: 44, OpenProcess=lambda *args: 22,
            OpenJobObjectW=lambda *args: 33, IsProcessInJob=member,
            CloseHandle=lambda handle: state['closed'].append(handle))
        self.expected = {'pid': 77, 'desktop': 'AgentD0_synthetic', 'session': 9}

    def set_error(self, value): self.error = value

    def failure(self, effect):
        try: effect()
        except Blocked as error:
            self.assertEqual(self.state['closed'], [22, 33])
            return diagnostics.failure_diagnostic('current', error)
        self.fail('uncertain identity must reject')

    def test_owned_top_level_window_uses_fresh_native_desktop_membership(self):
        result = self.api.identity(100)
        self.assertEqual(result, {**self.expected, 'alive': True, 'in_job': True})
        self.assertEqual(self.state['lookups'], [44])
        self.assertEqual(self.state['closed'], [22, 33])

    def test_owned_child_uses_parent_root_not_owner_window_or_config_name(self):
        result = self.api.identity(101)
        self.assertEqual(result['desktop'], 'AgentD0_synthetic')
        self.state['desktop'] = 'AgentD0_other'
        self.state['closed'].clear()
        with self.assertRaisesRegex(Blocked, 'target_desktop_mismatch'):
            self.api.guard(101, self.expected)

    def test_foreign_desktop_root_is_rejected_even_for_same_pid_and_job(self):
        self.state['windows'] = [200]
        diagnostic = self.failure(lambda: self.api.identity(100))
        self.assertEqual(diagnostic['chain'][0]['desktop']['source'], 'window-membership')
        self.assertEqual(diagnostic['chain'][0]['desktop']['operation'], 'EnumDesktopWindows')

    def test_missing_root_rejects_and_preserves_lookup_error(self):
        def ancestor(hwnd, flags): self.error = 6; return None
        self.api.u.GetAncestor = ancestor
        desktop = self.failure(lambda: self.api.identity(101))['chain'][0]['desktop']
        self.assertEqual((desktop['operation'], desktop['phase'], desktop['winerror']), ('GetAncestor', 'root-lookup', 6))

    def test_partial_enumeration_false_rejects_even_if_root_seen_and_error_zero(self):
        self.state['enumOk'] = False
        desktop = self.failure(lambda: self.api.identity(100))['chain'][0]['desktop']
        self.assertEqual(desktop['winerror'], 0)
        self.assertEqual(desktop['phase'], 'membership-probe')

    def test_enumeration_access_denied_remains_failure_with_immediate_error(self):
        self.state.update(enumOk=False, enumError=5)
        desktop = self.failure(lambda: self.api.identity(100))['chain'][0]['desktop']
        self.assertEqual(desktop['winerror'], 5)

    def test_window_budget_rejects_after_root_seen(self):
        self.state['windows'] = [100] * 1025
        self.failure(lambda: self.api.identity(100))

    def test_reparent_during_native_enumeration_rejects(self):
        roots = iter([100, 200])
        self.api.u.GetAncestor = lambda *args: next(roots)
        desktop = self.failure(lambda: self.api.identity(101))['chain'][0]['desktop']
        self.assertEqual(desktop['operation'], 'GetAncestor')

    def test_pid_or_thread_change_after_membership_rejects(self):
        enumerate_windows = self.api.u.EnumDesktopWindows
        for field, replacement in [('pid', 78), ('tid', 89)]:
            with self.subTest(field=field):
                self.state.update(pid=77, tid=88)
                self.state['closed'].clear()
                def change(*args):
                    result = enumerate_windows(*args)
                    self.state[field] = replacement
                    return result
                self.api.u.EnumDesktopWindows = change
                self.failure(lambda: self.api.identity(100))

    def test_window_destruction_after_membership_rejects(self):
        alive = iter([True, False])
        self.api.u.IsWindow = lambda hwnd: next(alive)
        self.failure(lambda: self.api.identity(100))

    def test_missing_job_view_does_not_replace_identity_with_expected_desktop(self):
        self.api.k.OpenJobObjectW = lambda *args: None
        result = self.api.identity(100)
        self.assertFalse(result['in_job'])
        self.assertIsNone(result['desktop'])
        self.assertEqual(self.state['lookups'], [])
        self.assertEqual(self.state['closed'], [22])

    def test_job_revocation_after_membership_rejects(self):
        enumerate_windows = self.api.u.EnumDesktopWindows
        def change(*args):
            result = enumerate_windows(*args)
            self.state['job'] = False
            return result
        self.api.u.EnumDesktopWindows = change
        self.failure(lambda: self.api.identity(100))

    def test_unowned_window_never_queries_any_desktop_and_cannot_pass_guard(self):
        self.state['job'] = False
        result = self.api.identity(100)
        self.assertFalse(result['in_job'])
        self.assertIsNone(result['desktop'])
        self.assertEqual(self.state['lookups'], [])
        self.state['closed'].clear()
        self.failure(lambda: self.api.guard(100, self.expected))

    def test_default_desktop_remains_forbidden_even_when_native_membership_is_true(self):
        self.state['desktop'] = 'Default'
        with self.assertRaisesRegex(Blocked, 'default_target_forbidden'):
            self.api.guard(100, {**self.expected, 'desktop': 'Default'})

    def test_session_mismatch_remains_forbidden(self):
        with self.assertRaisesRegex(Blocked, 'target_session_mismatch'):
            self.api.guard(100, {**self.expected, 'session': 10})


if __name__ == '__main__':
    unittest.main()
