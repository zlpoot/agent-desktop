"""Disposable capture process: host watchdog kills the owned job on a hang."""
import argparse
import hashlib
from pathlib import Path
import time
from storage import read_json, write_bytes, write_json
from win32 import Api
from policy import Blocked


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    target = read_json(args.directory / "target.json")
    api = Api()
    if target.get("dpi_aware"):
        api.capture_dpi()
    api.join_job_view(target["desktop"])
    def check_control():
        control = read_json(args.directory / "control.json", {})
        if control.get("stop", True) or time.monotonic() >= control.get("lease", 0):
            raise Blocked("control_lease_expired")
    api.check_control = check_control
    count = 0
    try:
        while True:
            control = read_json(args.directory / "control.json", {})
            if control.get("stop", True) or time.monotonic() >= control.get("lease", 0):
                break
            begin = time.monotonic()
            image, geometry = api.capture(target["hwnd"], target, target.get("print_flags", 0))
            count += 1
            write_bytes(args.directory / "frame.png", image)
            write_json(args.directory / "frame.json", {
                **geometry, "sequence": count, "time": time.time(), "heartbeat": time.monotonic(),
                "capture_ms": round((time.monotonic() - begin) * 1000, 2),
                "sha256": hashlib.sha256(image).hexdigest(),
            })
            time.sleep(max(0, 0.2 - (time.monotonic() - begin)))
    except Exception as error:
        control = read_json(args.directory / "control.json", {})
        if not control.get("stop", True) and time.monotonic() < control.get("lease", 0):
            write_json(args.directory / "frame.json", {"error": type(error).__name__, "reason": str(error), "time": time.time(),
                                                       "source_geometry": getattr(error, "geometry", None)})


if __name__ == "__main__":
    main()
