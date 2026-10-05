"""Managed local Worker gates; no OS calls or automation dependencies in this module."""
import copy
import time


class PhysicalGate:
    def __init__(self, context, policy, clock=time.monotonic, wall=time.time):
        self.context = context
        self.policy = copy.deepcopy(policy)
        self.clock, self.wall = clock, wall
        self.grant = None
        self.epoch = 0
        self.deadline = 0
        initial = context()
        self.bound_identity = {key: initial[key] for key in ("instanceId", "inputResourceId")}
        self.stale = False

    def identity(self, identity):
        current = self.context()
        if any(current[key] != value for key, value in self.bound_identity.items()):
            self.stale = True
            self.grant = None
            self.deadline = 0
        if self.stale or not identity or any(identity.get(key) != current[key]
                               for key in ("instanceId", "inputResourceId")):
            raise ValueError("Physical Worker instance/resource changed")
        return current

    def install(self, authority, expires_at):
        current = self.identity(authority)
        if not current["ready"]:
            raise ValueError("Physical desktop not ready")
        if (authority.get("providerId") != "physical" or not authority.get("sessionId") or
                not authority.get("environmentId") or not authority.get("grantId") or
                authority.get("owner", {}).get("kind") != "agent" or
                not authority.get("owner", {}).get("clientId") or
                not isinstance(authority.get("epoch"), int) or authority["epoch"] <= self.epoch or
                self.grant is not None):
            raise ValueError("Invalid physical input grant")
        remaining = min(3.0, expires_at / 1000 - self.wall())
        if remaining <= 0:
            raise ValueError("Expired physical input grant")
        self.grant = copy.deepcopy(authority)
        self.epoch = authority["epoch"]
        self.deadline = self.clock() + remaining

    def revoke(self, authority):
        self.identity(authority)
        if self.grant is not None and self.grant != authority:
            raise ValueError("Foreign physical input grant")
        self.grant = None
        self.deadline = 0

    def check(self, identity, authority, method, args):
        current = self.identity(identity)
        if not current["ready"]:
            raise ValueError("Physical desktop not ready")
        mutating = method in ("init", "restore", "execute") or method == "probe" and args.get("focus")
        if not mutating:
            return
        if authority != self.grant or self.grant is None or self.clock() >= self.deadline:
            raise ValueError("Invalid or expired physical input authority")
        if method in ("init", "restore", "probe"):
            if self.policy.get("windowManagement") is not True:
                raise ValueError("Physical window management forbidden by policy")
        elif args.get("action", {}).get("kind") not in ("wait", "screenshot"):
            allowed = args.get("allowedProviders")
            if not isinstance(allowed, list) or len(allowed) != 1 or allowed[0] not in self.policy.get("executors", []):
                raise ValueError("Physical global input forbidden by policy")
