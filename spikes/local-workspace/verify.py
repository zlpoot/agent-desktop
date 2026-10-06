"""Explicit real-Windows verifier. Never claims manual human input passed."""
import argparse
import ctypes as C
import json
from pathlib import Path
import platform
import sys
import time
from host import Controller, ROOT
from policy import Blocked
from storage import read_json, write_bytes, write_json


def wait(controller, predicate, seconds=12, renew=True):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        state = controller.ping() if renew else controller.snapshot()
        if predicate(state) or state["status"] == "stopped":
            return state
        time.sleep(0.1)
    raise TimeoutError("verification_wait_timeout")


def run(directory, app, case):
    controller = Controller(directory, real=True)
    evidence = {"app": app, "case": case, "human_parallel_input": "NOT_RUN", "viewer_render": "NOT_RUN"}
    try:
        state = controller.start(app)
        state = wait(controller, lambda s: s["status"] == "ready" and s.get("frame", {}).get("sequence", 0) >= 6)
        if state["status"] != "ready":
            evidence.update(outcome="UNSUPPORTED" if state.get("reason") == "packaged_notepad_unsupported" else "BLOCKED", result=state)
            return evidence
        before = controller.frame()
        write_bytes(controller.run_directory / "before.png", before)
        frame_start = state["frame"]
        controller.api.join_job_view(state["desktop"])
        target = read_json(controller.run_directory / "target.json")
        try:
            controller.api.guard(0, target)
            raise AssertionError("invalid HWND accepted")
        except Blocked:
            evidence["invalid_hwnd_rejected"] = True
        if case == "normal":
            controller.act(state["run_id"])
            state = wait(controller, lambda s: s.get("input") in ("PASS", "FAIL", "UNSUPPORTED"), 5)
            if state["status"] != "stopped":
                state = wait(controller, lambda s: s.get("frame", {}).get("sequence", 0) >= frame_start["sequence"] + 10, 5)
                write_bytes(controller.run_directory / "after.png", controller.frame())
                end = state["frame"]
                evidence.update(frame_changed=end["sha256"] != frame_start["sha256"],
                                measured_fps=round((end["sequence"] - frame_start["sequence"]) / (end["heartbeat"] - frame_start["heartbeat"]), 2),
                                observed_frames=end["sequence"], capture_ms=end["capture_ms"])
                evidence["outcome"] = "AUTOMATED_SUBSET_PASS" if state.get("input") == "PASS" and end.get("nonuniform") and evidence["frame_changed"] else "FAIL"
        elif case == "disconnect":
            state = wait(controller, lambda s: s["status"] == "stopped", 8, renew=False)
            evidence["outcome"] = "PASS" if state.get("stop_reason") == "viewer_disconnected_or_lease_expired" else "FAIL"
        elif case == "target_exit":
            # HWND visibility is desktop-scoped; the Default host never sends
            # messages to hidden windows. Kill only the worker-registered app PID
            # after proving exact membership in this run's job.
            from ctypes import wintypes as W
            process = controller.api.checked(controller.api.k.OpenProcess(0x1001, False, state["owned_pid"]), "open_owned_target")
            owned = W.BOOL()
            try:
                controller.api.checked(controller.api.k.IsProcessInJob(process, controller.job, C.byref(owned)), "target_membership")
                if not owned.value:
                    raise Blocked("target_outside_owned_job")
                controller.api.checked(controller.api.k.TerminateProcess(process, 1), "terminate_owned_target")
            finally:
                controller.api.k.CloseHandle(process)
            state = wait(controller, lambda s: s["status"] == "stopped", 8)
            evidence["outcome"] = "PASS" if state.get("stop_reason") in ("worker_blocked", "capture_error") else "FAIL"
        elif case == "capture_timeout":
            # Terminate only the registered capture process after proving exact job
            # membership. The frozen last frame must trigger the freshness watchdog.
            from ctypes import wintypes as W
            process = controller.api.checked(controller.api.k.OpenProcess(0x1001, False, state["capture_pid"]), "open_capture")
            owned = W.BOOL()
            try:
                controller.api.checked(controller.api.k.IsProcessInJob(process, controller.job, C.byref(owned)), "capture_membership")
                if not owned.value:
                    raise Blocked("capture_outside_owned_job")
                controller.api.checked(controller.api.k.TerminateProcess(process, 1), "terminate_owned_capture")
            finally:
                controller.api.k.CloseHandle(process)
            state = wait(controller, lambda s: s["status"] == "stopped", 8)
            evidence["outcome"] = "PASS" if state.get("stop_reason") == "capture_timeout" else "FAIL"
        elif case == "worker_exit":
            controller.api.checked(controller.api.k.TerminateProcess(controller.process, 1), "terminate_owned_worker")
            state = wait(controller, lambda s: s["status"] == "stopped", 8)
            evidence["outcome"] = "PASS" if state.get("stop_reason") == "worker_timeout" else "FAIL"
    except Exception as error:
        evidence.update(outcome="FAIL", error=type(error).__name__, reason=str(error))
    finally:
        state = controller.stop("verifier_complete")
        evidence["result"] = state
        if state.get("cleanup", {}).get("status") != "PASS":
            evidence["outcome"] = "FAIL"
        controller.close()
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--real", action="store_true", required=True)
    parser.add_argument("--app", choices=("all", "fixture", "notepad"), default="all")
    parser.add_argument("--faults", action="store_true", help="Also test fixture disconnect, target exit, stale capture and worker exit")
    parser.add_argument("--artifacts", type=Path, default=ROOT / ".artifacts" / "local-workspace")
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("Windows only")
    results = []
    for app in (("fixture", "notepad") if args.app == "all" else (args.app,)):
        cases = ("normal", "disconnect", "target_exit", "capture_timeout", "worker_exit") if args.faults and app == "fixture" else ("normal",)
        for case in cases:
            result = run(args.artifacts, app, case)
            results.append(result)
            print(json.dumps(result, ensure_ascii=False), flush=True)
    report = {"environment": {"python": platform.python_version(), "windows": platform.platform()},
              "scope": "D0-A automated subset; no human parallel-input claim; no D0-B",
              "results": results}
    write_json(args.artifacts / "verification.json", report)
    sys.exit(1 if any(r["outcome"] in ("FAIL", "BLOCKED") for r in results) else 0)


if __name__ == "__main__":
    main()
