"""Pure, offline-testable restrictions for the D0-A/B experiment."""
import struct
import zlib

TEXT = "hello from agent workspace"
MAX_DURATION = 60
LEASE_SECONDS = 3
HUMAN_LIMIT = 256
TEXT_LIMIT = 512


class Revoked(RuntimeError):
    """An input epoch changed; observation and the workspace may continue."""
    pass


class Blocked(RuntimeError):
    pass


def validate_epoch(owner, epoch, control):
    if owner not in ("agent", "human") or type(epoch) is not int or control.get("owner") != owner or control.get("epoch") != epoch:
        raise Revoked("input_epoch_revoked")


def validate_human_event(event):
    if not isinstance(event, dict):
        raise Blocked("invalid_human_event")
    if event.get("kind") == "char" and set(event) == {"kind", "value"}:
        value = event["value"]
        if not isinstance(value, str) or len(value) != 1 or not (32 <= ord(value) <= 126 or value == "\b"):
            raise Blocked("only_ASCII_or_backspace")
    elif event.get("kind") == "click" and set(event) == {"kind", "x", "y", "width", "height", "sequence"}:
        if any(type(event[k]) is not int for k in ("x", "y", "width", "height", "sequence")):
            raise Blocked("integer_frame_coordinates_required")
        if not (0 < event["width"] <= 2048 and 0 < event["height"] <= 2048 and
                0 <= event["x"] < event["width"] and 0 <= event["y"] < event["height"] and event["sequence"] >= 0):
            raise Blocked("click_outside_frame")
    else:
        raise Blocked("unsupported_human_event")


def expected_edit(text, start, end, char):
    if not (0 <= start <= end <= len(text) <= TEXT_LIMIT):
        raise Blocked("invalid_edit_selection")
    if char == "\b":
        result = text[:max(0, start - (start == end))] + text[end:]
    else:
        result = text[:start] + char + text[end:]
    if len(result) > TEXT_LIMIT:
        raise Blocked("text_limit_reached")
    return result


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
