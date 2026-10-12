"""Explicit R1-NATIVE-01 no-input probe; no Task, Registry, pipe or model.

Run --real for Desktop-only checks. Optional --testbench/--sha256 passively
launch a locally rebuilt owned TestBench in the single temporary Desktop/Job.
Only numeric API diagnostics and boolean relationships leave this process.
"""
import argparse
import ctypes as C
from ctypes import wintypes as W
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "desktop-provider"))
from testbench_worker import NativeBench, failure_diagnostic
from win32 import Api


class Queries:
    def __init__(self, native, report, owner):
        self.native, self.report, self.owner = native, report, owner

    def __getattr__(self, name):
        return getattr(self.native, name)

    def GetThreadDesktop(self, tid):
        result = self.native.GetThreadDesktop(tid)
        error = C.get_last_error()
        self.report.append({"source": self.owner.source, "operation": "GetThreadDesktop",
            "phase": "handle-lookup", "winerror": error, "handlePresent": bool(result),
            "status": "PASS" if result else "FAIL"})
        return result

    def GetUserObjectInformationW(self, handle, index, buffer, length, needed):
        result = self.native.GetUserObjectInformationW(handle, index, buffer, length, needed)
        error = C.get_last_error()
        required = needed._obj.value
        expected = buffer is None and not result and error == 122 and 0 < required <= 1024
        self.report.append({"source": self.owner.source, "operation": "GetUserObjectInformationW",
            "phase": "size-probe" if buffer is None else "name-read", "winerror": error,
            "requiredBytes": required, "handlePresent": bool(handle),
            "status": "EXPECTED_BUFFER_PROBE" if expected else "PASS" if result else "FAIL"})
        return result


class ProbeApi(Api):
    def __init__(self, report):
        super().__init__()
        self.source = "unspecified"
        self.u = Queries(self.u, report, self)

    def name(self, handle, source="unspecified"):
        self.source = source
        return super().name(handle, source)

    def thread_desktop(self, tid, source="unspecified"):
        self.source = source
        return super().thread_desktop(tid, source)


def cleanup_owned(api, previous, desktop, name, job, process, report):
    """Attempt every owned release independently; uncertainty always remains NACK."""
    cleanup = report["cleanup"]
    def attempt(field, effect):
        cleanup[field] = False
        try:
            cleanup[field] = bool(effect())
            if not cleanup[field]: raise ValueError("owned-cleanup-unconfirmed")
        except Exception as error:
            report["failures"].append({"phase": field, **failure_diagnostic("close", error)})
    def restore():
        api.checked(api.u.SetThreadDesktop(previous), "restore_controller_thread")
        return api.name(api.thread_desktop(api.k.GetCurrentThreadId(),
            "controller-restored"), "controller-restored").lower() == "default"
    def input_default():
        api.assert_default()
        return True
    def drain():
        api.checked(api.k.TerminateJobObject(job, 0), "owned_job_terminate")
        deadline = time.monotonic() + 3
        while api.job_active(job) and time.monotonic() < deadline: time.sleep(.01)
        return api.job_active(job) == 0
    def absent():
        deadline = time.monotonic() + 3
        while True:
            C.set_last_error(0)
            remaining = api.u.OpenDesktopW(name, 0, False, 1)
            error = C.get_last_error()
            if not remaining: return error == 2
            api.checked(api.u.CloseDesktop(remaining), "owned_desktop_probe_close")
            if time.monotonic() >= deadline: return False
            time.sleep(.01)
    attempt("controllerDefault", restore)
    attempt("inputDefault", input_default)
    if job: attempt("jobEmpty", drain)
    if process:
        attempt("processExited", lambda: api.k.WaitForSingleObject(process, 2000) == 0)
        attempt("processHandleClosed", lambda: api.checked(api.k.CloseHandle(process), "owned_process_close"))
    if job: attempt("jobHandleClosed", lambda: api.checked(api.k.CloseHandle(job), "owned_job_close"))
    if desktop:
        attempt("desktopHandleClosed", lambda: api.checked(api.u.CloseDesktop(desktop), "owned_desktop_close"))
        attempt("desktopAbsent", absent)


def run(binary=None, digest=None):
    report = {"scope": "R1-NATIVE-01", "queries": [], "checks": {}, "failures": [], "cleanup": {}}
    api = ProbeApi(report["queries"])
    bench = NativeBench.__new__(NativeBench)
    bench.api, bench.process = api, api.k.GetCurrentProcess()
    facts = bench.token_facts()
    report["checks"]["ordinaryUser"] = not facts["elevated"]
    report["checks"]["interactiveWindowStation"] = api.name(api.u.GetProcessWindowStation()).lower() == "winsta0"
    adv = C.WinDLL("advapi32", use_last_error=True)
    adv.OpenProcessToken.argtypes = [W.HANDLE, W.DWORD, C.POINTER(W.HANDLE)]
    adv.OpenProcessToken.restype = W.BOOL
    adv.IsTokenRestricted.argtypes, adv.IsTokenRestricted.restype = [W.HANDLE], W.BOOL
    token = W.HANDLE()
    api.checked(adv.OpenProcessToken(api.k.GetCurrentProcess(), 8, C.byref(token)), "probe_token")
    try: report["checks"]["restrictedToken"] = bool(adv.IsTokenRestricted(token))
    finally: api.checked(api.k.CloseHandle(token), "probe_token_close")
    if facts["elevated"] or report["checks"]["restrictedToken"] or not report["checks"]["interactiveWindowStation"]:
        raise ValueError("ordinary-user-required")
    api.assert_default()
    previous = api.thread_desktop(api.k.GetCurrentThreadId(), "controller-before-bind")
    if api.name(previous, "controller-before-bind").lower() != "default":
        raise ValueError("controller-default-required")
    report["checks"]["initialDefault"] = True
    default = api.checked(api.u.OpenDesktopW("Default", 0, False, 1), "default_desktop_open")
    try:
        if api.name(default, "controller-before-bind").lower() != "default":
            raise ValueError("explicit-default-required")
        report["checks"]["explicitDefault"] = True
    finally:
        api.checked(api.u.CloseDesktop(default), "default_desktop_close")
        report["checks"]["defaultHandleClosed"] = True
    bench.name = "AgentD0_Native_" + uuid.uuid4().hex
    bench.desktop = job = process = None
    phase = "desktop-create"
    try:
        bench.desktop = api.desktop(bench.name)
        phase = "original-retained"
        report["checks"]["originalRetained"] = api.name(bench.desktop, "original-retained") == bench.name
        if not report["checks"]["originalRetained"]: raise ValueError("original-desktop-required")
        # The HWND probe follows NativeBench.start's ordering: launch before any
        # helper binding. Desktop-only mode exercises binding without an app.
        if not binary:
            phase = "helper-bind-restore"
            with bench.window_desktop():
                report["checks"]["helperBound"] = True
        report["checks"]["helperRestored"] = api.name(
            api.thread_desktop(api.k.GetCurrentThreadId(), "controller-restored"), "controller-restored").lower() == "default"
        if not report["checks"]["helperRestored"]: raise ValueError("controller-restore-required")
        if binary:
            phase = "binary-check"
            path = Path(binary).resolve()
            if path.name != "WindowsAgentTestBench.exe" or not path.is_relative_to(ROOT / ".artifacts") or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise ValueError("owned-rebuilt-binary-required")
            report["binarySha256"] = digest
            job_name = bench.name + "_job"
            job = api.job(job_name)
            api.join_job_view(job_name)
            # Empty channel configuration means the app creates no Task/Oracle pipe.
            keys = ("AGENT_BENCH_TASK_PIPE", "AGENT_BENCH_TASK_SECRET", "AGENT_BENCH_TASK_ISSUER")
            prior = {key: os.environ.pop(key, None) for key in keys}
            try:
                phase = "process-launch"
                process, pid = api.launch([path, "--task-channel"], bench.name, job)
            finally:
                for key, value in prior.items():
                    if value is not None: os.environ[key] = value
            bench.process = process
            in_job = W.BOOL()
            api.checked(api.k.IsProcessInJob(process, job, C.byref(in_job)), "owned_process_job")
            report["checks"]["originalProcessInJob"] = bool(in_job.value)
            if not in_job.value: raise ValueError("original-job-membership-required")
            report["checks"]["processToken"] = bench.token_facts()
            if not all(report["checks"]["processToken"][key] for key in ("sameUser", "permissionsCompatible")) or report["checks"]["processToken"]["targetElevated"]:
                raise ValueError("ordinary-owned-process-required")
            session = api.session(api.k.GetCurrentProcessId())
            report["checks"]["sameSession"] = api.session(pid) == session
            if not report["checks"]["sameSession"]: raise ValueError("same-session-required")
            deadline = time.monotonic() + 8
            hwnd = None
            enumeration = {"attempts": 0, "ownedWindows": 0, "visibleOwnedWindows": 0, "wpfOwnedWindows": 0}
            report["checks"]["enumeration"] = enumeration
            phase = "window-enumeration"
            while time.monotonic() < deadline:
                matches = []
                enumeration["attempts"] += 1
                with bench.window_desktop():
                    report["checks"]["helperBound"] = True
                    for window in api.windows(bench.desktop):
                        owner = W.DWORD()
                        api.u.GetWindowThreadProcessId(window, C.byref(owner))
                        if owner.value == pid:
                            enumeration["ownedWindows"] += 1
                            visible = bool(api.u.IsWindowVisible(window))
                            wpf = api.class_name(window).startswith("HwndWrapper")
                            enumeration["visibleOwnedWindows"] += visible
                            enumeration["wpfOwnedWindows"] += wpf
                            if visible and wpf: matches.append(window)
                if len(matches) == 1:
                    hwnd = matches[0]
                    break
                if len(matches) > 1: raise ValueError("unique-owned-window-required")
                if api.k.WaitForSingleObject(process, 0) != 258: break
                time.sleep(.05)
            if not hwnd:
                report["checks"]["processStillRunningAtDeadline"] = api.k.WaitForSingleObject(process, 0) == 258
                api.k.GetExitCodeProcess.argtypes = [W.HANDLE, C.POINTER(W.DWORD)]
                api.k.GetExitCodeProcess.restype = W.BOOL
                code = W.DWORD()
                api.checked(api.k.GetExitCodeProcess(process, C.byref(code)), "owned_process_exit_code")
                report["checks"]["processExitCode"] = code.value
                raise ValueError("owned-window-unavailable")
            report["checks"]["uniqueOriginalWindow"] = True
            phase = "window-owner-query"
            # This is the reviewed original HWND guard, with no producer connection.
            with bench.window_desktop():
                identity = api.identity(hwnd)
                report["checks"]["windowIdentity"] = {
                    "alive": identity["alive"], "samePid": identity["pid"] == pid,
                    "sameSession": identity["session"] == session, "inJob": identity["in_job"],
                    "sameDesktop": identity["desktop"] == bench.name}
                api.guard(hwnd, {"pid": pid, "desktop": bench.name, "session": session})
                rect = W.RECT()
                api.checked(api.u.GetWindowRect(hwnd, C.byref(rect)), "owned_window_rect")
                report["checks"]["windowQueries"] = bool(api.class_name(hwnd) and rect.right > rect.left and rect.bottom > rect.top)
                if not report["checks"]["windowQueries"]: raise ValueError("owned-window-geometry-required")
    except Exception as error:
        report["failures"].append({"phase": phase, **failure_diagnostic("current", error)})
    finally:
        cleanup_owned(api, previous, bench.desktop, bench.name, job, process, report)
    report["status"] = "PASS" if not report["failures"] and all(report["cleanup"].values()) else "BLOCKED"
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--real", action="store_true", required=True)
    parser.add_argument("--testbench")
    parser.add_argument("--sha256")
    args = parser.parse_args()
    if os.name != "nt" or bool(args.testbench) != bool(args.sha256): parser.error("Windows and matching binary/digest options required")
    try:
        result = run(args.testbench, args.sha256)
    except Exception as error:
        result = {"status": "BLOCKED", "failures": [failure_diagnostic("current", error)]}
    print(json.dumps(result, indent=2))
    sys.exit(result["status"] != "PASS")
