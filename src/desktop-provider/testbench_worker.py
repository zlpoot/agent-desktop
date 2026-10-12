"""Private TestBench Local Workspace producer bridge. Importing never loads Win32.
No EVAL Oracle, global input, Desktop switch, reattachment, arbitrary executable or script.
Launch is fenced on the authoritative Registry. The actual WPF input producer owns
its SQLite write lock through synchronous commit; uncertain transport drains only the owned Job.
"""
import ctypes
from contextlib import contextmanager
import hashlib
import json
import traceback
import os
from pathlib import Path
import sqlite3
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "spikes" / "local-workspace"))

READ_BUTTONS = frozenset(("工作台", "客户管理", "订单管理", "系统设置", "查询客户",
                         "打开李四资料", "打开张三资料", "查看客户订单", "查询订单", "打开 O2026-1003", "打开 O2026-1004"))


def checked_action(action):
    if not isinstance(action, dict) or action.get("kind") not in ("click", "type"):
        raise ValueError("testbench-read-query-action-required")
    allowed = {"kind", "target", "postcondition"} if action["kind"] == "click" else {"kind", "target", "text"}
    target = action.get("target", {})
    if set(action) - allowed or not isinstance(target, dict) or set(target) != {"kind", "role", "name"} or target["kind"] != "role":
        raise ValueError("semantic-target-required")
    if action["kind"] == "click":
        if target["role"] != "button" or target["name"] not in READ_BUTTONS:
            raise ValueError("testbench-read-query-action-required")
    elif target["role"] != "edit" or target["name"] not in ("客户姓名", "订单客户姓名") or not isinstance(action.get("text"), str) or len(action["text"]) > 80 or any(ord(c) < 32 or ord(c) == 127 for c in action["text"]):
        raise ValueError("testbench-read-query-action-required")
    return action


class RegistryFence:
    def __init__(self, path, scope):
        # Existing authoritative file only; never create an alternative Registry.
        self.db = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=rw", uri=True, timeout=1)
        self.scope = scope
    def run(self, expected, effect, launch=False):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            scope = self.scope
            if expected["scope"] != scope:
                raise ValueError("foreign-app-scope")
            version = self.db.execute("SELECT version FROM private_app_denial_store").fetchall()
            if version != [(1,)]:
                raise ValueError("app-denial-store-unavailable")
            denied = self.db.execute("""SELECT 1 FROM private_app_denials WHERE provider_id=? AND environment_id=?
                AND (app_binding_id=? OR installation_id=? OR application_id=?) LIMIT 1""",
                (scope["providerId"], scope["environmentId"], expected["appBindingId"],
                 expected["installationId"], expected["applicationId"].lower())).fetchone()
            if denied:
                raise ValueError("app-admission-denied")
            environment = self.db.execute("""SELECT installation_scope_id, scope_revision FROM app_environments
                WHERE provider_id=? AND environment_id=?""", (scope["providerId"], scope["environmentId"])).fetchone()
            row = self.db.execute("""SELECT installation_scope_id, scope_revision, data_json FROM environment_apps
                WHERE provider_id=? AND environment_id=? AND app_binding_id=?""",
                (scope["providerId"], scope["environmentId"], expected["appBindingId"])).fetchone()
            if not environment or not row or environment[0] != scope["installationScopeId"] or row[:2] != environment:
                raise ValueError("app-scope-generation-changed")
            current = json.loads(row[2])
            fields = ("scope", "appBindingId", "installationId", "applicationId", "profileRevision",
                      "profileDigest", "identity", "launchSpec")
            if any(current.get(key) != expected.get(key) for key in fields) or current.get("validity") != "current" or current.get("availability") != "available" or current.get("trust") not in (("confirmed", "verified") if launch else ("verified",)):
                raise ValueError("app-trust-no-longer-current")
            if not any(c.get("profileRevision") == current["profileRevision"] and c.get("profileDigest") == current["profileDigest"] for c in current["confirmations"]):
                raise ValueError("app-confirmation-required")
            return effect()
        finally:
            # No data mutations. Release only after producer ACK/definite drain.
            self.db.rollback()
    def close(self):
        self.db.close()


class NativeBench:
    def __init__(self, config, registry, scope, session_id):
        from win32 import Api
        if os.name != "nt":
            raise ValueError("windows-testbench-only")
        self.api = Api()
        self.config, self.scope = config, scope
        self.session_id = session_id
        self.instance = uuid.uuid4().hex
        self.name = "AgentD0_Bench_" + uuid.uuid4().hex
        self.job_name = self.name + "_job"
        self.desktop = self.job = self.process = None
        self.pid = self.target = self.incarnation = None
        self.hwnd = None
        self.grant = None
        self.epoch = 0
        self.lease = 0
        self.consumed = set()
        self.registry_path = str(Path(registry).resolve())
        self.fence = RegistryFence(registry, scope)
        self.binary = None
        try:
            self.api.assert_default()
            # Retain a non-share-write/delete original executable handle for the Session.
            from ctypes import wintypes as W
            k = self.api.k
            k.CreateFileW.argtypes = [W.LPCWSTR, W.DWORD, W.DWORD, ctypes.c_void_p, W.DWORD, W.DWORD, W.HANDLE]
            k.CreateFileW.restype = W.HANDLE
            self.binary = k.CreateFileW(config["path"], 0x80000000, 1, None, 3, 0x80, None)
            if self.binary == ctypes.c_void_p(-1).value:
                self.binary = None
                raise ValueError("testbench-binary-pin-unavailable")
            self.inspect()
            self.desktop = self.api.desktop(self.name)
            self.job = self.api.job(self.job_name)
            self.api.join_job_view(self.job_name)
        except BaseException:
            self.close()
            raise
    def clock(self):
        self.api.k.GetTickCount64.restype = ctypes.c_uint64
        return self.api.k.GetTickCount64()
    def inspect(self):
        path = Path(self.config["path"])
        if path.name.lower() != "windowsagenttestbench.exe" or not path.is_absolute() or hashlib.sha256(path.read_bytes()).hexdigest() != self.config["sha256"]:
            raise ValueError("testbench-installation-mismatch")
        return {"productId": "WindowsAgentTestBench", "version": "task-channel-v1", "fingerprint": self.config["sha256"]}
    def token_facts(self):
        # Read original process tokens; do not invent sameUser/elevation flags.
        from ctypes import wintypes as W
        adv = ctypes.WinDLL("advapi32", use_last_error=True)
        adv.OpenProcessToken.argtypes = [W.HANDLE, W.DWORD, ctypes.POINTER(W.HANDLE)]
        adv.OpenProcessToken.restype = W.BOOL
        adv.GetTokenInformation.argtypes = [W.HANDLE, ctypes.c_int, ctypes.c_void_p, W.DWORD, ctypes.POINTER(W.DWORD)]
        adv.GetTokenInformation.restype = W.BOOL
        adv.EqualSid.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        adv.EqualSid.restype = W.BOOL
        def read(process):
            token, size = W.HANDLE(), W.DWORD()
            self.api.checked(adv.OpenProcessToken(process, 8, ctypes.byref(token)), "original_process_token")
            try:
                adv.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
                if not 0 < size.value < 65536: raise ValueError("token_user_unavailable")
                user = ctypes.create_string_buffer(size.value)
                self.api.checked(adv.GetTokenInformation(token, 1, user, len(user), ctypes.byref(size)), "original_token_user")
                elevation = W.DWORD()
                self.api.checked(adv.GetTokenInformation(token, 20, ctypes.byref(elevation), ctypes.sizeof(elevation), ctypes.byref(size)), "original_token_elevation")
                return user, bool(elevation.value)
            finally: self.api.k.CloseHandle(token)
        parent, parent_elevated = read(self.api.k.GetCurrentProcess())
        child, child_elevated = read(self.process)
        same_user = bool(adv.EqualSid(ctypes.c_void_p.from_buffer(parent), ctypes.c_void_p.from_buffer(child)))
        return {"sameUser": same_user, "elevated": parent_elevated, "targetElevated": child_elevated,
                "permissionsCompatible": same_user and parent_elevated == child_elevated}
    def context(self):
        return {"scope": self.scope, "sessionId": self.session_id, "instanceId": self.instance,
                "windowsSessionId": self.api.session(os.getpid()), "desktop": self.name}
    @contextmanager
    def window_desktop(self):
        # Window USER-object queries belong to the original owned Desktop, like D0's
        # isolated worker. This binds this helper thread only; never SwitchDesktop.
        self.api.assert_default()
        if not self.desktop or self.api.name(self.desktop, "original-retained") != self.name:
            raise ValueError("original-desktop-handle-required")
        tid = self.api.k.GetCurrentThreadId()
        previous = self.api.thread_desktop(tid, "controller-before-bind")
        if not previous or self.api.name(previous, "controller-before-bind").lower() != "default":
            raise ValueError("window-probe-controller-not-default")
        self.api.checked(self.api.u.SetThreadDesktop(self.desktop), "original_window_desktop_bind")
        try:
            if self.api.name(self.api.thread_desktop(tid, "controller-bound"), "controller-bound") != self.name:
                raise ValueError("original-window-desktop-unconfirmed")
            self.api.assert_default()  # The user's input Desktop must stay Default.
            yield
        finally:
            self.api.checked(self.api.u.SetThreadDesktop(previous), "restore_controller_thread")
            if self.api.name(self.api.thread_desktop(tid, "controller-restored"), "controller-restored").lower() != "default":
                raise ValueError("controller-desktop-restore-unconfirmed")
    def current(self):
        self.api.assert_default()
        self.inspect()
        if not self.desktop or not self.job:
            raise ValueError("workspace-closed")
        if self.process:
            if self.api.k.WaitForSingleObject(self.process, 0) != 258:
                raise ValueError("original-process-ended")
            facts = self.token_facts()
            if not facts["sameUser"] or not facts["permissionsCompatible"]: raise ValueError("original_process_permissions_changed")
            if self.hwnd:
                with self.window_desktop():
                    self.api.guard(self.hwnd, {"pid": self.pid, "desktop": self.name, "session": self.context()["windowsSessionId"]})
        return self.context()
    def pipe(self, method, **args):
        # Private current-user pipe is created by original BenchWindow, verifies worker PID + secret.
        import threading
        result = []
        def read():
            try:
                with open("\\\\.\\pipe\\" + self.pipe_name, "r+b", buffering=0) as stream:
                    raw = json.dumps({"secret": self.secret, "method": method, **args}, ensure_ascii=False).encode() + b"\n"
                    stream.write(raw)
                    line = bytearray()
                    while len(line) <= 1024 * 1024:
                        char = stream.read(1)
                        if not char or char == b"\n":
                            break
                        line.extend(char)
                    response = json.loads(line)
                    if "error" in response:
                        error = ValueError("testbench-producer-rejected")
                        diagnostic = response.get("diagnostic", {})
                        # Only constant codes emitted by the reviewed producer are retained.
                        codes = {"peer-depth-budget", "peer-history-budget", "original-window-closed", "peer-budget", "producer-bind-reused", "unsupported-method", "producer-not-bound", "stale-producer-admission", "semantic-target-required", "control-incarnation-changed", "native-peer-required", "read-query-action-required", "producer-operation-failed"}
                        types = {"InvalidOperationException", "ArgumentException", "NullReferenceException", "ElementNotAvailableException", "Exception"}
                        if isinstance(diagnostic, dict) and diagnostic.get("code") in codes and diagnostic.get("type") in types:
                            error.producer_diagnostic = {"code": diagnostic["code"], "type": diagnostic["type"]}
                        raise error
                    result.append(response)
            except BaseException as error:
                result.append(error)
        thread = threading.Thread(target=read, daemon=True)
        thread.start()
        thread.join(2)
        if thread.is_alive() or not result:
            # Unknown producer outcomes never acknowledge cleanup; drain only the owned Job.
            self.drain()
            raise ValueError("producer-ack-unconfirmed")
        if isinstance(result[0], BaseException):
            self.drain()
            raise ValueError("producer-transport-unconfirmed") from result[0]
        return result[0]
    def start(self, profile):
        if self.process:
            raise ValueError("replacement-launch-forbidden")
        def launch():
            self.current()
            self.check_profile(profile)
            self.pipe_name, self.secret = "AgentBench_" + uuid.uuid4().hex, uuid.uuid4().hex
            keys = {"AGENT_BENCH_TASK_PIPE": self.pipe_name, "AGENT_BENCH_TASK_SECRET": self.secret,
                    "AGENT_BENCH_TASK_ISSUER": str(os.getpid())}
            prior = {key: os.environ.get(key) for key in keys}
            try:
                os.environ.update(keys)
                # Existing Api launches suspended into owned hidden Desktop/Job before ResumeThread.
                self.process, self.pid = self.api.launch([self.config["path"], "--task-channel"], self.name, self.job)
            finally:
                for key, value in prior.items():
                    if value is None: os.environ.pop(key, None)
                    else: os.environ[key] = value
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                # Wait for our owned app pipe without dispatching input.
                self.api.k.WaitNamedPipeW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32]
                if self.api.k.WaitNamedPipeW("\\\\.\\pipe\\" + self.pipe_name, 100):
                    capture = self.pipe("observe")
                    self.hwnd, self.incarnation = capture["hwnd"], capture["incarnation"]
                    if capture["pid"] != self.pid:
                        raise ValueError("foreign-producer")
                    self.current()
                    self.target = uuid.uuid4().hex
                    return self.target
                time.sleep(.05)
            self.drain()
            raise ValueError("testbench-launch-unconfirmed")
        return self.fence.run(profile, launch, launch=True)
    def check_profile(self, profile):
        if profile["identity"] != self.inspect() or profile["launchSpec"] != {"kind": "exe", "executable": self.config["path"], "args": ["--task-channel"]}:
            raise ValueError("testbench-profile-mismatch")
    def evidence(self, profile):
        self.current()
        self.check_profile(profile)
        if not self.target: return []
        capture = self.pipe("observe")
        self.validate_capture(capture)
        facts = self.token_facts()
        return [{**self.context(), "targetToken": self.target, "identity": self.inspect(),
                 "executable": self.config["path"], "args": ["--task-channel"], "processOwnedByInstallation": True,
                 "windowOwnedByProcess": True, "sameUser": facts["sameUser"], "permissionsCompatible": facts["permissionsCompatible"]}]
    def validate_capture(self, capture):
        self.current()
        if capture["pid"] != self.pid or capture["hwnd"] != self.hwnd or capture["incarnation"] != self.incarnation:
            raise ValueError("original-window-incarnation-changed")
    def bind(self, profile, target):
        self.check_profile(profile)
        if target != {**self.context(), "targetToken": self.target, "identity": self.inspect()}:
            raise ValueError("original-issued-target-required")
        self.current()
        native_profile = {key: profile[key] for key in ("scope", "appBindingId", "installationId", "applicationId", "profileRevision", "profileDigest", "identity", "launchSpec")}
        response = self.pipe("bind", registry=self.registry_path, profile=native_profile)
        if response.get("bound") is not True: raise ValueError("native-producer-bind-unconfirmed")
        self.profile = profile
    def activate(self, authority):
        if self.grant or authority["epoch"] <= self.epoch or authority["owner"]["kind"] != "agent" or any(authority[key] != value for key, value in
            {"providerId": self.scope["providerId"], "environmentId": self.scope["environmentId"], "sessionId": self.session_id, "instanceId": self.instance,
             "inputResourceId": self.instance}.items()):
            raise ValueError("input-grant-mismatch")
        self.current()
        self.grant = authority
        self.epoch = authority["epoch"]
        self.lease = self.clock() + 3000
    def owned(self, authority):
        if authority != self.grant or not self.grant or self.clock() >= self.lease:
            raise ValueError("input-authority-expired-or-revoked")
        self.current()
    def observe(self):
        self.current()
        capture = self.pipe("observe")
        self.validate_capture(capture)
        self.observation = capture["observation"]
        self.observed_at = self.clock()
        from ctypes import wintypes as W
        rect = W.RECT()
        with self.window_desktop():
            self.api.checked(self.api.u.GetWindowRect(self.hwnd, ctypes.byref(rect)), "original_window_rect")
            capture["rect"] = {"left": rect.left, "top": rect.top, "width": rect.right - rect.left, "height": rect.bottom - rect.top}
            capture["windowClass"] = self.api.class_name(self.hwnd)
        capture.update(self.token_facts())
        return capture
    def execute(self, authority, action, observation, action_id):
        checked_action(action)
        if not action_id or action_id in self.consumed or len(self.consumed) >= 512:
            raise ValueError("action-id-reused-or-budget")
        self.consumed.add(action_id)
        def effect():
            self.owned(authority)
            self.check_profile(self.profile)
            if observation != getattr(self, "observation", None) or self.clock() - self.observed_at >= 5000:
                raise ValueError("fresh-observation-required")
            self.observation = None
            response = self.pipe("execute", action=action, observation=observation,
                                 incarnation=self.incarnation, leaseDeadline=self.lease)
            if response.get("committed") is not True:
                self.drain()
                raise ValueError("producer-commit-unconfirmed")
            return {"ok": True, "effect": "dispatched", "provider": "testbench.owned-peer", "message": "Owned TestBench semantic action committed"}
        # The native WPF producer owns the authoritative SQLite transaction through commit.
        return effect()
    def drain(self):
        self.grant = None
        if self.job:
            self.api.checked(self.api.k.TerminateJobObject(self.job, 1), "owned_job_terminate")
            deadline = time.monotonic() + 2
            while self.api.job_active(self.job) and time.monotonic() < deadline: time.sleep(.01)
            if self.api.job_active(self.job): raise RuntimeError("owned-job-drain-unconfirmed")
    def close(self):
        errors = []
        try:
            self.drain()
        except BaseException as error:
            errors.append(error)
        # Exhaust every owned resource even when drain/Desktop confirmation fails.
        for field in ("process", "job"):
            handle = getattr(self, field)
            if handle:
                if field == "process":
                    try:
                        if self.api.k.WaitForSingleObject(handle, 2000) != 0:
                            raise RuntimeError("owned-process-exit-unconfirmed")
                    except BaseException as error:
                        errors.append(error)
                try:
                    self.api.checked(self.api.k.CloseHandle(handle), "owned_" + field + "_close")
                except BaseException as error:
                    errors.append(error)
                finally:
                    setattr(self, field, None)
        if self.desktop:
            try:
                self.api.checked(self.api.u.CloseDesktop(self.desktop), "owned_desktop_close")
                self.desktop = None
                # Job accounting can reach zero before Windows completes Desktop rundown.
                # Only an absent original name confirms cleanup; each probe handle is closed.
                deadline = time.monotonic() + 2
                while True:
                    ctypes.set_last_error(0)
                    remaining = self.api.u.OpenDesktopW(self.name, 0, False, 1)
                    if not remaining:
                        if ctypes.get_last_error() != 2:  # ERROR_FILE_NOT_FOUND, not access/probe failure.
                            raise RuntimeError("owned-desktop-absence-unconfirmed")
                        break
                    self.api.checked(self.api.u.CloseDesktop(remaining), "owned_desktop_probe_close")
                    if time.monotonic() >= deadline:
                        raise RuntimeError("owned-desktop-cleanup-unconfirmed")
                    time.sleep(.01)
            except BaseException as error:
                errors.append(error)
        if self.binary:
            try:
                self.api.checked(self.api.k.CloseHandle(self.binary), "owned_binary_close")
            except BaseException as error:
                errors.append(error)
            finally:
                self.binary = None
        try:
            self.fence.close()
        except BaseException as error:
            errors.append(error)
        if errors:
            raise RuntimeError("owned-cleanup-unconfirmed") from errors[0]



# Private operator diagnostics: no exception messages, request bodies, paths or credentials.
# The RPC error code remains unchanged and every failure continues to fail closed.
def failure_diagnostic(method, error):
    methods = {"init", "inspect", "current", "start", "instances", "bind", "activate", "ping", "revoke", "observe", "execute", "close"}
    chain = []
    for _ in range(3):
        frames = traceback.extract_tb(error.__traceback__)
        origin = next((frame for frame in reversed(frames) if Path(frame.filename).name in ("testbench_worker.py", "win32.py", "policy.py")), None)
        item = {"type": type(error).__name__}
        for field in ("errno", "winerror"):
            value = getattr(error, field, None)
            if isinstance(value, int):
                item[field] = value
        if origin:
            item["site"] = {"file": Path(origin.filename).name, "function": origin.name, "line": origin.lineno}
        desktop = getattr(error, "desktop_diagnostic", None)
        if isinstance(desktop, dict):
            from win32 import DESKTOP_DIAGNOSTIC_SOURCES
            # Reject arbitrary metadata even on an exception from a native/producer boundary.
            if (isinstance(desktop.get("source"), str) and desktop["source"] in DESKTOP_DIAGNOSTIC_SOURCES and
                desktop.get("operation") in ("GetThreadDesktop", "GetUserObjectInformationW") and
                desktop.get("phase") in ("handle-lookup", "size-probe", "name-read") and
                type(desktop.get("winerror")) is int and 0 <= desktop["winerror"] <= 0xFFFFFFFF and
                type(desktop.get("handlePresent")) is bool):
                item["desktop"] = {key: desktop[key] for key in ("source", "operation", "phase", "winerror", "handlePresent")}
                if type(desktop.get("requiredBytes")) is int and 0 <= desktop["requiredBytes"] <= 0xFFFFFFFF:
                    item["desktop"]["requiredBytes"] = desktop["requiredBytes"]
        producer = getattr(error, "producer_diagnostic", None)
        if producer:
            item["producer"] = producer
        chain.append(item)
        error = error.__cause__ or (None if error.__suppress_context__ else error.__context__)
        if error is None:
            break
    return {"method": method if method in methods else "unknown", "chain": chain}


def serve():
    bench = None
    try:
        for line in sys.stdin:
            request = json.loads(line)
            args, method = request.get("args", {}), request["method"]
            try:
                if method == "init":
                    if bench: raise ValueError("init-reused")
                    bench = NativeBench(args["config"], args["registry"], args["scope"], args["sessionId"])
                    result = bench.context()
                elif not bench or request.get("instance") != bench.instance:
                    raise ValueError("foreign-backend-instance")
                elif method == "inspect": result = bench.inspect()
                elif method == "current": result = bench.current()
                elif method == "start": result = bench.start(args["profile"])
                elif method == "instances": result = bench.evidence(args["profile"])
                elif method == "bind": result = bench.bind(args["profile"], args["target"])
                elif method == "activate": result = bench.activate(args["authority"])
                elif method == "ping":
                    bench.owned(args["authority"]); bench.lease = bench.clock() + 3000; result = None
                elif method == "revoke":
                    if bench.grant != args["authority"]: raise ValueError("foreign-grant")
                    bench.grant = None; bench.epoch += 1; result = None
                elif method == "observe": result = bench.observe()
                elif method == "execute": result = bench.execute(args["authority"], args["action"], args["observation"], args["actionId"])
                elif method == "close":
                    bench.close(); bench = None; result = None
                else: raise ValueError("unsupported-method")
                print(json.dumps({"id": request["id"], "result": result}, ensure_ascii=False), flush=True)
            except BaseException as error:
                print(json.dumps({"id": request["id"], "error": "testbench-" + method + "-rejected",
                                  "diagnostic": failure_diagnostic(method, error)}), flush=True)
    finally:
        if bench: bench.close()


if __name__ == "__main__":
    serve()
