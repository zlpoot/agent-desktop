"""Pure, offline-testable restrictions for the D0-A experiment."""
import struct
import zlib

TEXT = "hello from agent workspace"
MAX_DURATION = 60
LEASE_SECONDS = 3


class Blocked(RuntimeError):
    pass


def validate_target(identity, expected):
    if not identity.get("alive"):
        raise Blocked("target_exited")
    for key in ("pid", "desktop", "session"):
        if identity.get(key) != expected.get(key):
            raise Blocked("target_" + key + "_mismatch")
    if not identity.get("in_job"):
        raise Blocked("target_outside_owned_job")
    if identity["desktop"].lower() == "default":
        raise Blocked("default_target_forbidden")


def validate_command(command, run_id, now, lease, stopped):
    if stopped or now >= lease:
        raise Blocked("control_lease_expired")
    if command.get("run_id") != run_id:
        raise Blocked("stale_run")
    if command.get("action") != "script":
        raise Blocked("unsupported_action")
    if now >= command.get("expires", 0):
        raise Blocked("expired_command")


def png_rgb(width, height, rgb):
    if not (0 < width <= 2048 and 0 < height <= 2048) or len(rgb) != width * height * 3:
        raise ValueError("invalid frame geometry")
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\0" + rgb[y * width * 3:(y + 1) * width * 3] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 1)) + chunk(b"IEND", b""))
