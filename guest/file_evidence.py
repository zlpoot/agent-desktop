"""Bounded, read-only evidence for files under the current user's Desktop."""

import hashlib
import os
import time
from pathlib import Path

MAX_FILE_BYTES = 1_048_576
MAX_TEXT_BYTES = 16_384


def inspect_desktop_file(requested: str, desktop_root: Path | None = None) -> dict:
    if not isinstance(requested, str) or not requested or len(requested) > 260 or "\x00" in requested:
        raise ValueError("Invalid Desktop file path")
    root = (desktop_root or Path.home() / "Desktop").resolve(strict=True)
    path = Path(requested)
    path = (path if path.is_absolute() else root / path).resolve(strict=False)
    if path == root or not path.is_relative_to(root):
        raise ValueError("File evidence is restricted to Desktop files")
    result = {"path": str(path), "root": str(root), "capturedAt": int(time.time() * 1000),
              "exists": False, "complete": True}
    try:
        stat = path.stat()
    except FileNotFoundError:
        return result
    if not path.is_file():
        return {**result, "exists": True, "kind": "non_file", "complete": False}
    result.update(exists=True, kind="file", size=stat.st_size,
                  mtimeMs=int(stat.st_mtime_ns / 1_000_000))
    if stat.st_size > MAX_FILE_BYTES:
        result["complete"] = False
        return result
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        data = stream.read(MAX_FILE_BYTES + 1)
        after = os.fstat(stream.fileno())
    if (len(data) > MAX_FILE_BYTES or before.st_size != len(data) or
            before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns):
        result["complete"] = False
        return result
    result["sha256"] = hashlib.sha256(data).hexdigest()
    if len(data) <= MAX_TEXT_BYTES:
        try:
            result["text"] = (data.decode("utf-16") if data.startswith((b"\xff\xfe", b"\xfe\xff"))
                              else data.decode("utf-8-sig"))
        except UnicodeDecodeError:
            pass
    result["capturedAt"] = int(time.time() * 1000)
    return result
