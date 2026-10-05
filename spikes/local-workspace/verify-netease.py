"""Explicit D0-C installed NetEase boundary probe; no global input fallback."""
import argparse
import json
from pathlib import Path
import sys
import time
from host import Controller, ROOT


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--real", required=True, action="store_true")
    parser.add_argument("--path", type=Path, required=True)
    parser.add_argument("--song", default="我怀念的")
    parser.add_argument("--artist", default="孙燕姿")
    parser.add_argument("--takeover", action="store_true", help="Also verify bounded search editing and resume")
    parser.add_argument("--disconnect", action="store_true", help="Finally expire the Viewer lease in human mode")
    args = parser.parse_args()
    if sys.platform != "win32": parser.error("Windows required")
    controller = Controller(ROOT / ".artifacts" / "d0c-netease", real=True,
                            netease={"path": str(args.path), "song": args.song, "artist": args.artist})
    report = {"scope": "D0-C NetEase startup/search/play", "input": "NOT_RUN", "global_input": "PROHIBITED"}
    def wait(predicate, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            snapshot = controller.ping()
            if snapshot["status"] == "stopped": raise RuntimeError("run_stopped:" + str(snapshot.get("reason", snapshot.get("stop_reason"))))
            if predicate(snapshot): return snapshot
            time.sleep(0.03)
        raise RuntimeError("probe_condition_timeout")

    def human(event):
        current = controller.snapshot()
        response = controller.receive_input(current["run_id"], current["epoch"], event)
        identifier = response["accepted_command"]
        result = wait(lambda s: s.get("last_command", {}).get("id") == identifier, 5)
        if result["last_command"]["result"] != "APPLIED": raise RuntimeError("human_command_rejected")
        return result

    def click_node(predicate):
        from storage import read_json
        nodes = [x for x in read_json(controller.run_directory / "uia.json", []) if predicate(x) and not x["offscreen"]]
        if len(nodes) != 1: raise RuntimeError("human_target_not_unique")
        target = read_json(controller.run_directory / "target.json")
        left, top = target["origin"]
        rect = nodes[0]["rect"]
        frame = controller.snapshot()["frame"]
        return human({"kind": "click", "x": (rect[0] + rect[2]) // 2 - left,
                      "y": (rect[1] + rect[3]) // 2 - top,
                      **{k: frame[k] for k in ("width", "height", "sequence")}})
    try:
        controller.start("netease")
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            state = controller.ping()
            if state["status"] == "stopped" or (state.get("input_ready") and state.get("frame", {}).get("sequence", 0) >= 5):
                break
            time.sleep(0.1)
        if state["status"] == "ready" and state.get("input_ready"):
            controller.act(state["run_id"],state["epoch"])
            if args.takeover:
                state = wait(lambda s: s.get("agent_progress") == 1, 12)
                old_epoch, deadline = state["epoch"], controller.deadline
                controller.transfer(state["run_id"], state["epoch"], "human")
                state = wait(lambda s: s.get("control_ready") and s["owner"] == "human", 5)
                progress = state["agent_progress"]
                time.sleep(0.4)
                if controller.ping()["agent_progress"] != progress: raise RuntimeError("agent_not_paused")
                from policy import Blocked
                try: controller.act(state["run_id"], old_epoch)
                except Blocked: pass
                else: raise RuntimeError("stale_epoch_accepted")
                click_node(lambda x: x["role"] == 50004)
                human({"kind": "char", "value": "X"})
                human({"kind": "char", "value": "\b"})
                state = controller.snapshot()
                controller.transfer(state["run_id"], state["epoch"], "agent")
                wait(lambda s: s.get("control_ready") and s["owner"] == "agent", 5)
                if controller.deadline != deadline: raise RuntimeError("resume_extended_budget")
                report["takeover"] = {"status": "PASS", "paused_progress": progress, "human_actions": 3,
                                      "edit_and_backspace_verified": True, "old_epoch_rejected": True, "budget_preserved": True}
            deadline=time.monotonic()+35
            while time.monotonic()<deadline:
                state=controller.ping()
                if state["status"]=="stopped" or state.get("input")=="PASS":break
                time.sleep(0.1)
            if args.takeover and state.get("input") == "PASS":
                controller.transfer(state["run_id"], state["epoch"], "human")
                wait(lambda s: s.get("control_ready") and s["owner"] == "human", 5)
                state = click_node(lambda x: x["auto_id"] == "btn_pc_minibar_play")
                if state["playing"]: raise RuntimeError("human_pause_not_verified")
                state = click_node(lambda x: x["auto_id"] == "btn_pc_minibar_play")
                if not state["playing"]: raise RuntimeError("human_play_not_verified")
                controller.transfer(state["run_id"], state["epoch"], "agent")
                state = wait(lambda s: s.get("control_ready") and s["owner"] == "agent", 5)
                report["takeover"].update(play_pause_verified=True, human_actions=state["human_actions"])
        report.update(outcome="AUTOMATED_SUBSET_PASS" if state.get("input")=="PASS" and state["status"]=="ready" else "BLOCKED",
                      stage=state.get("stage"), reason=state.get("reason"), uia_elements=state.get("uia_elements"),
                      frame=state.get("frame"), app_version=state.get("app_version"), stop_reason=state.get("stop_reason"),
                      input=state.get("input"),agent_progress=state.get("agent_progress"),track_matches=state.get("track_matches"),playing=state.get("playing"))
        report["playback_evidence"] = "exact result selected; matching title and current pause control; audible output requires human confirmation"
        if args.disconnect and report["outcome"] == "AUTOMATED_SUBSET_PASS":
            controller.transfer(state["run_id"], state["epoch"], "human")
            wait(lambda s: s.get("control_ready") and s["owner"] == "human", 5)
            deadline = time.monotonic() + 5
            while controller.snapshot()["status"] != "stopped" and time.monotonic() < deadline:
                time.sleep(0.03)  # No renewal; do not substitute a manual Stop.
            result = controller.snapshot()
            if result.get("stop_reason") != "viewer_disconnected_or_lease_expired":
                raise RuntimeError("human_disconnect_not_verified")
            report["disconnect"] = {"status": "PASS", "stop_reason": result["stop_reason"]}
    except Exception as error:
        report.update(outcome="BLOCKED", reason=str(error))
    finally:
        result = controller.stop("probe_complete")
        report["cleanup"] = result.get("cleanup")
        report["monitor"] = result.get("monitor")
        from storage import write_json
        write_json(controller.run_directory / "probe.json", report)
        controller.close()
    print(json.dumps(report, ensure_ascii=False))
    sys.exit(0 if report.get("outcome") == "AUTOMATED_SUBSET_PASS" and report["cleanup"]["status"] == "PASS" else 1)


if __name__ == "__main__": main()
