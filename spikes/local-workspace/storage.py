"""Per-run files are private artifacts, never repository fixtures."""
import json
import os
from pathlib import Path
import time


def write_bytes(path, data):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(data)
    # Windows readers may briefly deny delete-sharing. Retry only that transient
    # replacement conflict; a sustained failure still stops the run.
    for attempt in range(25):
        try:
            os.replace(temporary, path)
            return
        except PermissionError:
            if attempt == 24:
                raise
            time.sleep(0.02)


def write_json(path, data):
    write_bytes(path, json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"))


def read_json(path, default=None):
    # Brief Windows sharing conflicts during atomic replacement may make a
    # current control file unreadable. Never reuse stale permissions: retry for
    # at most 20 ms, then return the fail-closed default. Lease clocks still run.
    for attempt in range(5):
        try:
            return json.loads(Path(path).read_text(encoding="utf-8"))
        except (FileNotFoundError, PermissionError):
            if attempt == 4:
                return default
            time.sleep(0.005)
        except json.JSONDecodeError:
            return default
