"""Input ownership only; transition and dispatch callers hold the Worker lock."""
import secrets
import threading


class InputControl:
    def __init__(self):
        self.mode = "paused"
        self.lease = None
        self.revoked = threading.Event()
        self.revision = 0
        self.revision_lock = threading.Lock()

    def emergency(self):
        self.revoked.set()

    def request(self, mode, revision):
        if not isinstance(revision, int) or isinstance(revision, bool):
            raise ValueError("Control revision required")
        with self.revision_lock:
            if revision <= self.revision:
                raise ValueError("Stale control request")
            self.revision = revision
            if mode == "stopped":
                self.emergency()

    def transition(self, mode, revision=None):
        with self.revision_lock:
            if revision is not None and revision != self.revision:
                raise ValueError("Superseded control request")
            return self._transition(mode)

    def _transition(self, mode):
        if mode not in {"agent", "paused", "human", "stopped"}:
            raise ValueError("Invalid input mode")
        self.mode = mode
        self.lease = secrets.token_hex(24) if mode == "human" else None
        if mode == "stopped":
            self.revoked.set()
        else:
            self.revoked.clear()
        return {"mode": self.mode, "lease": self.lease}

    def require_agent(self):
        if self.revoked.is_set() or self.mode != "agent":
            raise ValueError("Agent input is disabled")

    def require_human(self, lease):
        if (self.revoked.is_set() or self.mode != "human" or not self.lease or
                not isinstance(lease, str) or not secrets.compare_digest(self.lease, lease)):
            raise ValueError("Human input lease is invalid")
