"""Shared, pure target-ownership and PNG primitives; no D0 input/lease policy."""
import struct
import zlib


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

def png_rgb(width, height, rgb):
    if not (0 < width <= 2048 and 0 < height <= 2048) or len(rgb) != width * height * 3:
        raise ValueError("invalid frame geometry")
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\0" + rgb[y * width * 3:(y + 1) * width * 3] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 1)) + chunk(b"IEND", b""))
