"""D0-C disposable installed-app worker. No Default Desktop input or models."""
import argparse
from pathlib import Path
import sys
import time
from policy import Blocked, Revoked
from storage import read_json, write_json
from win32 import Api, C, W

HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    directory = parser.parse_args().directory
    config = read_json(directory / "config.json")
    api = Api()
    handles = []
    state = {"status": "starting", "app": "netease", "run_id": config["run_id"], "stage": "launch", "input": "NOT_RUN"}
    target = uia = None
    def publish():
        state.update(time=time.time(), heartbeat=time.monotonic())
        write_json(directory / "worker.json", state)
    def check_control():
        control = read_json(directory / "control.json", {})
        if control.get("stop", True) or time.monotonic() >= control.get("lease", 0):
            raise Blocked("control_lease_expired")
    api.check_control = check_control
    try:
        api.join_job_view(config["desktop"])
        api.capture_dpi()
        api.assert_default()
        if api.name(api.u.GetThreadDesktop(api.k.GetCurrentThreadId())) != config["desktop"]:
            raise Blocked("worker_desktop_mismatch")
        handle, launcher = api.launch([config["netease"]["path"], "--force-renderer-accessibility"], config["desktop"])
        handles.append(handle)
        state["launcher_pid"] = launcher
        desktop = api.u.GetThreadDesktop(api.k.GetCurrentThreadId())
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            check_control(); api.assert_default()
            candidates = []
            for hwnd in api.windows(desktop):
                identity = api.identity(hwnd)
                if identity.get("in_job") and api.class_name(hwnd) == "OrpheusBrowserHost":
                    candidates.append((hwnd, identity))
            if len(candidates) == 1:
                target, identity = candidates[0]
                expected = {k: identity[k] for k in ("pid", "desktop", "session")}
                api.guard(target, expected)
                break
            if len(candidates) > 1:
                raise Blocked("ambiguous_owned_music_windows")
            publish(); time.sleep(0.1)
        if not target:
            raise Blocked("no_owned_music_window_possible_singleton_or_broker")
        state.update(owned_pid=expected["pid"], isolation="PASS", stage="capture", window_visible=bool(api.u.IsWindowVisible(target)))
        ready_at = time.monotonic() + 2
        while time.monotonic() < ready_at:
            check_control(); publish(); time.sleep(0.1)
        api.size_owned_window(target, expected, 1600, 1000)
        time.sleep(0.3)
        bounds = W.RECT()
        api.checked(api.u.GetWindowRect(target, C.byref(bounds)), "music_window_bounds")
        write_json(directory / "target.json", {**expected, "hwnd": target, "print_flags": 2, "dpi_aware": True,
                                               "origin": [bounds.left, bounds.top]})
        handle, capture = api.launch([sys.executable, HERE / "capture.py", directory], config["desktop"])
        handles.append(handle); state["capture_pid"] = capture
        # Observe before any input. Raw UIA names and frames remain private.
        state["stage"] = "uia_observe"; publish()
        from uia import Uia
        uia = Uia(api, target, expected)
        uia.heartbeat = publish
        from netease_input import MusicInputs
        inputs = MusicInputs(api,uia,target,expected,config["netease"],lambda:read_json(directory/"control.json",{}),config["run_id"],publish,
                             lambda rows: write_json(directory / "uia.json", rows))
        state.update(status="ready", stage="uia_observe", agent_progress=0, agent_total=4)
        until = time.monotonic() + 8
        while time.monotonic() < until:
            check_control(); api.guard(target, expected)
            rows = inputs.observe()
            children = [{"hwnd": h, "class": api.class_name(h), "identity": api.identity(h)} for h in api.windows(target, children=True)]
            write_json(directory / "native-children.json", children)
            write_json(directory / "uia.json", rows)
            state.update(uia_elements=len(rows), native_children=len(children), window_visible=bool(api.u.IsWindowVisible(target)))
            publish(); time.sleep(0.5)
            if any(x["role"] == 50004 and not x["offscreen"] for x in rows): break
        while True:
            check_control(); api.guard(target, expected)
            control=read_json(directory/"control.json",{})
            previous = (inputs.owner, inputs.epoch)
            inputs.acknowledge(control)
            if previous != (inputs.owner, inputs.epoch):
                state.update(inputs.view()); publish()
            for path in sorted((directory/"commands").glob("*.json"))[:1]:
                command=read_json(path,{})
                path.unlink(missing_ok=True)
                inputs.command(command)
            try: inputs.step()
            except Revoked:
                if inputs.pending_effect:
                    raise Blocked("music_input_effect_unknown_fail_closed")
            state.update(inputs.view())
            publish(); time.sleep(0.1)
    except Exception as error:
        state.update(status="blocked", reason=str(error), error=type(error).__name__)
    finally:
        publish()
        if uia:
            try: uia.close()
            except Exception: pass
        if target:
            try: api.close_owned_window(target, expected)
            except Exception: pass
        for handle in handles: api.k.CloseHandle(handle)


if __name__ == "__main__": main()
