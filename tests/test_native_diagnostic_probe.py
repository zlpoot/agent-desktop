"""Synthetic no-input probe contracts; no DLL load, Desktop or app creation."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("native_probe", ROOT / "scripts/probe-testbench-native.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeContracts(unittest.TestCase):
    def api(self):
        def checked(result, label):
            if not result: raise OSError(5, "synthetic-private-message")
            return result
        return SimpleNamespace(checked=checked, name=lambda *args: "Default",
            thread_desktop=lambda *args: 1, assert_default=lambda: None,
            job_active=lambda job: 0,
            u=SimpleNamespace(SetThreadDesktop=Mock(return_value=1),
                CloseDesktop=Mock(return_value=1), OpenDesktopW=Mock(return_value=None)),
            k=SimpleNamespace(GetCurrentThreadId=lambda: 8, TerminateJobObject=Mock(return_value=1),
                WaitForSingleObject=Mock(return_value=0), CloseHandle=Mock(return_value=1)))

    def cleanup(self, api, error=2):
        report = {"cleanup": {}, "failures": []}
        with patch.object(probe.C, "set_last_error", create=True), patch.object(probe.C, "get_last_error", return_value=error, create=True):
            probe.cleanup_owned(api, 1, 2, "synthetic-private-desktop", 3, 4, report)
        self.assertNotIn("synthetic-private", json.dumps(report))
        return report

    def test_restore_failure_still_drains_and_releases_every_owned_handle(self):
        api = self.api()
        api.u.SetThreadDesktop.return_value = 0
        report = self.cleanup(api)
        self.assertFalse(report["cleanup"]["controllerDefault"])
        api.k.TerminateJobObject.assert_called_once_with(3, 0)
        self.assertEqual(api.k.CloseHandle.call_args_list, [unittest.mock.call(4), unittest.mock.call(3)])
        api.u.CloseDesktop.assert_called_once_with(2)
        self.assertTrue(report["cleanup"]["desktopAbsent"])
        self.assertEqual(len(report["failures"]), 1)

    def test_failed_drain_and_unknown_exit_never_ack_but_still_close_job_and_desktop(self):
        api = self.api()
        api.k.TerminateJobObject.return_value = 0
        api.k.WaitForSingleObject.return_value = 258
        report = self.cleanup(api)
        self.assertFalse(report["cleanup"]["jobEmpty"])
        self.assertFalse(report["cleanup"]["processExited"])
        self.assertTrue(report["cleanup"]["jobHandleClosed"])
        self.assertTrue(report["cleanup"]["desktopHandleClosed"])

    def test_absence_access_denied_is_nack_even_after_successful_handle_close(self):
        report = self.cleanup(self.api(), error=5)
        self.assertTrue(report["cleanup"]["desktopHandleClosed"])
        self.assertFalse(report["cleanup"]["desktopAbsent"])
        self.assertEqual(report["failures"][0]["phase"], "desktopAbsent")

    def test_desktop_close_failure_remains_nack_even_if_name_later_absent(self):
        api = self.api()
        api.u.CloseDesktop.return_value = 0
        report = self.cleanup(api)
        self.assertFalse(report["cleanup"]["desktopHandleClosed"])
        self.assertTrue(report["cleanup"]["desktopAbsent"])
        self.assertEqual(len(report["failures"]), 1)

    def test_zero_error_and_null_handle_are_failure_without_private_identifiers(self):
        events = []
        native = SimpleNamespace(GetThreadDesktop=lambda tid: None)
        wrapper = probe.Queries(native, events, SimpleNamespace(source="window-owner-thread"))
        with patch.object(probe.C, "get_last_error", return_value=0, create=True):
            self.assertIsNone(wrapper.GetThreadDesktop(987654321))
        self.assertEqual(events[0]["status"], "FAIL")
        self.assertFalse(events[0]["handlePresent"])
        self.assertNotIn("987654321", json.dumps(events))

    def test_only_legal_insufficient_buffer_probe_is_expected(self):
        for error, required, expected in ((122, 16, True), (122, 0, False), (6, 0, False), (0, 0, False)):
            events = []
            native = SimpleNamespace(GetUserObjectInformationW=lambda *args: 0)
            wrapper = probe.Queries(native, events, SimpleNamespace(source="original-retained"))
            needed = probe.W.DWORD(required)
            with patch.object(probe.C, "get_last_error", return_value=error, create=True):
                wrapper.GetUserObjectInformationW(987654321, 2, None, 0, probe.C.byref(needed))
            self.assertEqual(events[0]["status"], "EXPECTED_BUFFER_PROBE" if expected else "FAIL")
            self.assertNotIn("987654321", json.dumps(events))


if __name__ == "__main__":
    unittest.main()
