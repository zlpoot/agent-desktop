"""D0-A worker runs only on the assigned non-input Desktop."""
import argparse
from pathlib import Path
import sys
import time
from policy import Blocked, TEXT, validate_command
from storage import read_json, write_json
from win32 import Api

HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    directory = args.directory
    config = read_json(directory / "config.json")
    api = Api()
    def check_control():
        control = read_json(directory / "control.json", {})
        if control.get("stop", True) or time.monotonic() >= control.get("lease", 0):
            raise Blocked("control_lease_expired")
    api.check_control = check_control
    handles = []
    state = {"status": "starting", "app": config["app"], "run_id": config["run_id"], "input": "NOT_RUN"}
    def publish():
        state["time"] = time.time()
        state["heartbeat"] = time.monotonic()
        write_json(directory / "worker.json", state)
    try:
        api.join_job_view(config["desktop"])
        if api.name(api.u.GetThreadDesktop(api.k.GetCurrentThreadId())) != config["desktop"]:
            raise Blocked("worker_desktop_mismatch")
        api.assert_default()
        argv = ([sys.executable, HERE / "fixture.py"] if config["app"] == "fixture" else [config["notepad"]])
        app_handle, pid = api.launch(argv, config["desktop"])
        handles.append(app_handle)
        state["owned_pid"] = pid
        expected = {"pid": pid, "desktop": config["desktop"], "session": api.session(api.k.GetCurrentProcessId())}
        desktop = api.u.GetThreadDesktop(api.k.GetCurrentThreadId())
        target = None
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            control = read_json(directory / "control.json", {})
            if control.get("stop", True) or time.monotonic() >= control.get("lease", 0):
                raise Blocked("control_lease_expired")
            api.assert_default()
            for hwnd in api.windows(desktop):
                identity = api.identity(hwnd)
                if identity.get("pid") == pid:
                    api.guard(hwnd, expected)
                    if api.class_name(hwnd) in ("AgentD0Fixture", "Notepad"):
                        target = hwnd
                        break
            if target:
                break
            state["time"] = time.time()
            publish()
            time.sleep(0.1)
        if not target:
            raise Blocked("no_owned_target_window_possible_broker_redirect")
        state["isolation"] = "PASS"
        write_json(directory / "target.json", {**expected, "hwnd": target})
        capture_handle, capture_pid = api.launch([sys.executable, HERE / "capture.py", directory], config["desktop"])
        state["capture_pid"] = capture_pid
        handles.append(capture_handle)
        state["status"] = "ready"
        seen = None
        input_done = False
        while True:
            control = read_json(directory / "control.json", {})
            if control.get("stop", True) or time.monotonic() >= control.get("lease", 0):
                state["status"] = "stopped"
                state["reason"] = "stop_or_lease_expired"
                break
            api.guard(target, expected)
            command = read_json(directory / "command.json", {})
            if command and command.get("id") != seen:
                validate_command(command, config["run_id"], time.monotonic(), control["lease"], control.get("stop"))
                if input_done:
                    raise Blocked("script_already_executed")
                seen = command["id"]
                children = api.windows(target, children=True)
                edits = [hwnd for hwnd in children if api.class_name(hwnd).lower() == "edit"]
                buttons = [hwnd for hwnd in children if api.class_name(hwnd).lower() == "button"]
                if len(edits) != 1 or (config["app"] == "fixture" and len(buttons) != 1):
                    state["input"] = "UNSUPPORTED"
                    state["reason"] = "standard_controls_unavailable_UIA_not_implemented"
                else:
                    for hwnd in edits + buttons:
                        api.guard(hwnd, expected)
                    if api.text(edits[0]) != "":
                        raise Blocked("nonempty_target_refuse_overwrite")
                    api.type_text(edits[0], expected, TEXT)
                    if config["app"] == "fixture":
                        api.click(buttons[0], expected)
                    # Wait for actual processing, then inspect the independent control state.
                    deadline = time.monotonic() + 2
                    text_ok = click_ok = False
                    while time.monotonic() < deadline:
                        api.guard(edits[0], expected)
                        text_ok = api.text(edits[0]) == TEXT
                        click_ok = config["app"] != "fixture"
                        for hwnd in children:
                            if api.class_name(hwnd).lower() == "static":
                                api.guard(hwnd, expected)
                                click_ok |= api.text(hwnd) == "Clicks: 1"
                        if text_ok and click_ok:
                            break
                        time.sleep(0.05)
                    state.update(input="PASS" if text_ok and click_ok else "FAIL", text_verified=text_ok,
                                 click_verified=click_ok if config["app"] == "fixture" else "NOT_RUN",
                                 method="WM_CHAR / WM_LBUTTONDOWN+UP" if config["app"] == "fixture" else "WM_CHAR")
                input_done = True
            publish()
            time.sleep(0.1)
    except Exception as error:
        state.update(status="blocked", reason=str(error), error=type(error).__name__)
    finally:
        publish()
        # Gracefully close only the verified top-level owned window. Host job handles
        # enforce eventual cleanup even if Notepad opens an unsaved-document dialog.
        if "target" in locals() and target:
            try:
                api.close_owned_window(target, expected)
            except Exception:
                pass
        for handle in handles:
            api.k.CloseHandle(handle)


if __name__ == "__main__":
    main()
