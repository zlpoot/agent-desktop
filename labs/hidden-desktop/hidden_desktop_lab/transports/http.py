"""Local HTTP adapter over an explicitly owned bench application."""
import argparse
import json
import os
import socket
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from capabilities import CAPABILITIES, MAX_LEASE, CapabilityError
from hidden_desktop import Blocked
from learned_replay import ReplayError
from live_preview import PreviewError
from app_startup import select_started_window
from hidden_desktop_lab.bootstrap import PAGE_LEASE_SECONDS, create_application

DEFAULT_PORT = 8790
MAX_BODY = 65536


class Handler(BaseHTTPRequestHandler):
    server_version = "BaseCapabilityBench/1.0"

    @property
    def app(self):
        return self.server.application

    def log_message(self, *_):
        pass

    # -- 输出 -------------------------------------------------------------- #
    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path, content_type):
        try:
            with open(path, "rb") as stream:
                body = stream.read()
        except OSError:
            return self._json({"ok": False, "message": "内容已失效"}, 404)
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _png(self, info, body):
        self.send_response(200)
        self.send_header('Content-Type', 'image/png')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Lab-Frame', json.dumps(info, ensure_ascii=True, separators=(',', ':')))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # 客户端离开后没有后台生产者继续抓图。

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ValueError("request-too-large")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _local_only(self):
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        return host in ("127.0.0.1", "localhost", "[::1]")

    # -- 路由 -------------------------------------------------------------- #
    def do_GET(self):
        route = urlparse(self.path).path
        if not self._local_only():
            return self._json({"ok": False, "message": "仅允许本机访问"}, 403)
        if route in ("/", "/index.html"):
            return self._file(os.path.join(str(self.app.paths.root), "ui.html"), "text/html; charset=utf-8")
        query = parse_qs(urlparse(self.path).query)
        profile = (query.get('profile') or ['default'])[0]
        if profile not in self.app.replays:
            return self._json({'ok': False, 'message': '未知流程配置'}, 404)
        replay, library = self.app.replays[profile], self.app.libraries[profile]
        if route == '/api/workflows':
            return self._json({'ok': True, 'pages': self.app.workflow_pages})
        if route in self.app.workflow_pages:
            return self._file(self.app.experiment.page_file, 'text/html; charset=utf-8')
        if route == '/workflow.js':
            return self._file(os.path.join(str(self.app.paths.root), 'workflow.js'), 'text/javascript; charset=utf-8')
        if route == '/api/composition':
            try:
                return self._json({'ok': True, 'registry': library.summary()})
            except (ValueError, OSError, ReplayError) as error:
                return self._json({'ok': False, 'error': {'code': 'composition-unavailable', 'detail': str(error)}}, 409)
        if route == "/learned-skills.js":
            return self._file(os.path.join(str(self.app.paths.root), "learned-skills.js"), "text/javascript; charset=utf-8")
        if route == '/live-preview.js':
            return self._file(os.path.join(str(self.app.paths.root), 'live-preview.js'), 'text/javascript; charset=utf-8')
        if route == "/api/state":
            return self._json({"ok": True, "state": self.app.snapshot(profile)})
        if route in ('/api/learned/status', '/api/learned/latest'):
            job_id = 'latest' if route.endswith('/latest') else (parse_qs(urlparse(self.path).query).get('id') or [''])[0]
            try:
                job = replay.status(job_id)
                payload = {'ok': True, 'job': job}
                if job['status'] != 'running':
                    payload['state'] = self.app.snapshot(profile)
                return self._json(payload)
            except ReplayError as error:
                if route.endswith('/latest'):
                    return self._json({'ok': True, 'job': None})
                return self._json({'ok': False, 'error': {'code': str(error)}}, 404)
        if route == "/api/preview.png":
            token = (parse_qs(urlparse(self.path).query).get("token") or [""])[0]
            desktop = self.app.lab.desktop
            try:
                info, image = self.app.preview.get(desktop, token)
            except Exception as error:
                return self._json({"ok": False, "message": str(error)}, 404)
            return self._png(info, image)
        return self._json({"ok": False, "message": "未知路径"}, 404)

    def do_POST(self):
        route = urlparse(self.path).path
        if not self._local_only():
            return self._json({"ok": False, "message": "仅允许本机访问"}, 403)
        if self.headers.get("X-Lab") != "1":
            return self._json({"ok": False, "message": "缺少本机页面标识"}, 403)
        profile = (parse_qs(urlparse(self.path).query).get('profile') or ['default'])[0]
        if profile not in self.app.replays:
            return self._json({'ok': False, 'error': {'code': 'unknown-workflow-profile'}}, 404)
        try:
            payload = self._body()
        except Exception as error:
            return self._json({"ok": False, "message": "请求体无效: %s" % error}, 400)

        if route == "/api/invoke":
            return self._invoke(payload, profile)
        if route == '/api/preview/live':
            # 独立只读路径，不排在 UIA/学习持有的执行锁之后。
            # Desktop 内的预览锁保证 capture 与 close 不会交叉释放资源。
            try:
                info, image = self.app.preview.capture(self.app.lab.desktop)
                return self._png(info, image)
            except (Blocked, PreviewError) as error:
                code = str(error).replace('_', '-')
                return self._json({'ok': False, 'error': {'code': code}},
                                  429 if code in ('preview-busy', 'preview-rate-limited') else 409)
            except Exception as error:
                return self._json({'ok': False, 'error': {'code': 'preview-capture-failed', 'detail': str(error)}}, 500)
        if route == '/api/learned/start':
            if not isinstance(payload, dict) or not isinstance(payload.get('action'), str) or not isinstance(payload.get('inputs', {}), dict):
                return self._json({'ok': False, 'error': {'code': 'invalid-replay-request'}}, 400)
            profile = (parse_qs(urlparse(self.path).query).get('profile') or ['default'])[0]
            if profile not in self.app.replays:
                return self._json({'ok': False, 'error': {'code': 'unknown-workflow-profile'}}, 404)
            replay = self.app.replays[profile]
            if self.app.replay_busy():
                return self._json({'ok': False, 'error': {'code': 'replay-busy'}}, 409)
            with self.app.lock:
                try:
                    if self.app.replay_busy():
                        raise ReplayError('replay-busy')
                    # 同一隐藏桌面只允许一条执行链；切换应用/流程时废弃其他实例的临时证据。
                    for other in self.app.replays.values():
                        if other is not replay:
                            other.invalidate()
                    job_id = replay.start(payload['action'], payload.get('inputs'))
                    return self._json({'ok': True, 'jobId': job_id})
                except ReplayError as error:
                    return self._json({'ok': False, 'error': {'code': str(error)}}, 409)
        if route == "/api/reset":
            with self.app.lock:
                self.app.lab.log = []
                self.app.last.clear()
                self.app.preview.clear()
                return self._json({"ok": True, "result": {"message": "日志与画面已清空"}, "state": self.app.snapshot(profile)})
        return self._json({"ok": False, "message": "未知动作"}, 404)

    def _invoke(self, payload, profile='default'):
        capability_id = str(payload.get("id") or "")
        arguments = payload.get("arguments") or {}
        if self.app.replay_busy():
            return self._json({'ok': False, 'error': {'code': 'replay-busy'}}, 409)
        with self.app.lock:
            if self.app.replay_busy():
                return self._json({'ok': False, 'error': {'code': 'replay-busy'}}, 409)
            try:
                if capability_id.startswith('act.') or capability_id in ('env.hidden.open', 'env.app.launch', 'env.app.close', 'locate.window'):
                    for replay in self.app.replays.values():
                        replay.invalidate()
                outcome = self.app.lab.invoke(capability_id, arguments)
                if capability_id == 'env.app.launch':
                    startup = select_started_window(self.app.lab, arguments, self.app.app_presets)
                    if startup is not None:
                        outcome['result']['startup'] = startup
                        outcome['elapsedMs'] += startup['elapsedMs']
                        self.app.lab.log_line('启动后已唯一选定主窗口：%s (%s)，归属核验通过'
                                     % (startup['window']['title'], startup['window']['hwnd']))
                if capability_id in ('observe.capture', 'verify.capture.rendered'):
                    outcome['result'] = self.app.publish_preview(outcome['result'])
            except CapabilityError as error:
                self.app.lab.log_line("%s 被拒：%s" % (capability_id, error.code), "error")
                self.app.last["invoke"] = {"id": capability_id, "ok": False, "error": error.payload()}
                return self._json({"ok": False, "capability": capability_id,
                                   "error": error.payload(), "state": self.app.snapshot(profile)})
            except Exception as error:                     # 兜底：绝不吞掉
                self.app.lab.log_line("%s 未预期失败：%s" % (capability_id, error), "error")
                payload_error = {"code": "dispatch-effect-unknown", "kind": "unknown",
                                 "detail": "%s: %s" % (type(error).__name__, error)}
                self.app.last["invoke"] = {"id": capability_id, "ok": False, "error": payload_error}
                return self._json({"ok": False, "capability": capability_id,
                                   "error": payload_error, "state": self.app.snapshot(profile)},
                                  status=500)

            capability = next(c for c in CAPABILITIES if c["id"] == capability_id)
            self.app.lab.log_line("%s 成功（%d ms）" % (capability_id, outcome["elapsedMs"]))
            # 画面文件与桌面同生命周期：这两个动作会让旧 token 彻底失效，必须一起清掉，
            # 否则新会话一建立，页面就会去请求上一轮已删除的图（404）。
            if capability_id in ("env.hidden.open", "env.app.close"):
                self.app.preview.clear()
            elif capability["layer"] in ("execute", "environment"):
                self.app.auto_capture()
            self.app.last["invoke"] = {"id": capability_id, "ok": True, "result": outcome["result"],
                              "elapsedMs": outcome["elapsedMs"]}
            return self._json({"ok": True, "capability": capability_id, **outcome,
                               "state": self.app.snapshot(profile)})


def free_port(preferred):
    for port in range(preferred, preferred + 50):
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise SystemExit("找不到可用端口")


def create_server(application, port):
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.application = application
    return server


def main():
    parser = argparse.ArgumentParser(description="Hidden Desktop 基础能力测试台")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--lease", type=int, default=PAGE_LEASE_SECONDS,
                        help="隐藏桌面租约秒数（1..%d），默认 %d" % (MAX_LEASE, PAGE_LEASE_SECONDS))
    parser.add_argument("--no-browser", action="store_true")
    arguments = parser.parse_args()

    if not 0 < arguments.lease <= MAX_LEASE:
        raise SystemExit("--lease 必须在 1..%d 之间" % MAX_LEASE)
    application = create_application(lease=arguments.lease)

    server = None
    try:
        port = free_port(arguments.port)
        url = "http://127.0.0.1:%d/" % port
        server = create_server(application, port)
        print("LAB_URL=" + url, flush=True)
        print("按 Ctrl+C 停止。", flush=True)
        if not arguments.no_browser:
            threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            application.close()
        finally:
            if server is not None:
                server.server_close()
