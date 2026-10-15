"""基础能力测试台：本地服务。

页面上的每一项都对应 `capabilities.py` 里的一条**声明**；这个服务只做三件事：
  1. 把声明连同实时可用性（按事实判定）暴露出去；
  2. 按能力 id 分发调用，把内部异常翻译成声明里的稳定错误码；
  3. 执行类动作后自动抓一张画面 —— 让"效果"直接可见。

它不自己定义任何能力，也不放宽任何边界：能不能做、拒绝什么、上限多少，全部来自声明。

用法：
    python server.py                 # 默认端口 8790，被占用时自动向后找
    python server.py --lease 30      # 租约秒数（1..3600），默认 300
    python server.py --no-browser

跨站防护：只接受 Host 为 127.0.0.1/localhost，写操作要求自定义头 X-Lab: 1。
"""
import argparse
import json
import os
import socket
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from capabilities import CAPABILITIES, MAX_LEASE, CapabilityError, CapabilityRuntime  # noqa: E402
from capabilities import _as_code  # noqa: E402
from hidden_desktop import Blocked  # noqa: E402
from learned_replay import LearnedReplay, ReplayError  # noqa: E402
from live_preview import LivePreview, PreviewError  # noqa: E402
from skill_composition import SkillLibrary  # noqa: E402
from replay_contract import validate_recipe  # noqa: E402
from experiment_config import load_experiment  # noqa: E402

LAB_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8790
PAGE_LEASE_SECONDS = 300
MAX_BODY = 65536

# 人盯着看的检查台，所以租约给 5 分钟；仍是有界且显式可续，不做静默续期。
LAB = CapabilityRuntime(lease=PAGE_LEASE_SECONDS)
LOCK = threading.RLock()
LAST = {"preview": None}
PREVIEW = LivePreview()


def publish_preview(info):
    try:
        return PREVIEW.evidence(LAB.desktop, info)
    except Blocked as error:
        raise _as_code(error) from error
    except PreviewError as error:
        raise CapabilityError('target-identity-changed', str(error)) from error


EXPERIMENT = load_experiment(LAB_DIR)
LIBRARY = SkillLibrary(EXPERIMENT.workflow, EXPERIMENT.capabilities, validate_recipe, require_local=True)
REPLAY = LearnedReplay(LAB, LOCK,
                       EXPERIMENT.template, EXPERIMENT.learned,
                       publish_preview, library=LIBRARY,
                       job_path=EXPERIMENT.record, paths_path=EXPERIMENT.paths)


def snapshot():
    """声明 + 事实 + 可用性 + 日志，供页面渲染。"""
    with LOCK:
        facts = LAB.facts()
        capabilities = []
        for capability in CAPABILITIES:
            entry = dict(capability)
            entry.update(LAB.evaluate(capability, facts))
            capabilities.append(entry)
        desktop = LAB.desktop
        return {
            "facts": facts,
            "actions": {"used": LAB.actions, "max": LAB.max_actions},
            "lease": {
                "leaseSeconds": desktop.lifetime if desktop and desktop.context else None,
                "remaining": desktop.remaining() if desktop and desktop.context else None,
                "expired": bool(desktop and desktop.context and desktop.remaining() == 0),
            },
            "capabilities": capabilities,
            "log": LAB.log[-120:],
            "last": LAST.get("invoke"),
            "lastPreview": PREVIEW.latest(desktop),
            "previewSession": desktop.context['instanceId'] if desktop and desktop.context else None,
            "previewTransport": PREVIEW.stats(desktop),
            "learned": REPLAY.summary(),
        }


def auto_capture():
    """补充只读画面；传输文件读取后立即回收。"""
    desktop = LAB.desktop
    if desktop is None or not desktop.context or desktop.blocked:
        return
    try:
        info, image = desktop.capture_frame(allow_unrendered=True)
        PREVIEW.publish(desktop, info, image)
    except Exception as error:
        LAB.log_line('自动画面未取得：' + str(error), 'warning')
        return


class Handler(BaseHTTPRequestHandler):
    server_version = "BaseCapabilityBench/1.0"

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
            return self._file(os.path.join(LAB_DIR, "ui.html"), "text/html; charset=utf-8")
        if route == EXPERIMENT.page_route:
            return self._file(EXPERIMENT.page_file, 'text/html; charset=utf-8')
        if route == '/workflow.js':
            return self._file(os.path.join(LAB_DIR, 'workflow.js'), 'text/javascript; charset=utf-8')
        if route == '/api/composition':
            try:
                return self._json({'ok': True, 'registry': LIBRARY.summary()})
            except (ValueError, OSError, ReplayError) as error:
                return self._json({'ok': False, 'error': {'code': 'composition-unavailable', 'detail': str(error)}}, 409)
        if route == "/learned-skills.js":
            return self._file(os.path.join(LAB_DIR, "learned-skills.js"), "text/javascript; charset=utf-8")
        if route == '/live-preview.js':
            return self._file(os.path.join(LAB_DIR, 'live-preview.js'), 'text/javascript; charset=utf-8')
        if route == "/api/state":
            return self._json({"ok": True, "state": snapshot()})
        if route in ('/api/learned/status', '/api/learned/latest'):
            job_id = 'latest' if route.endswith('/latest') else (parse_qs(urlparse(self.path).query).get('id') or [''])[0]
            try:
                job = REPLAY.status(job_id)
                payload = {'ok': True, 'job': job}
                if job['status'] != 'running':
                    payload['state'] = snapshot()
                return self._json(payload)
            except ReplayError as error:
                if route.endswith('/latest'):
                    return self._json({'ok': True, 'job': None})
                return self._json({'ok': False, 'error': {'code': str(error)}}, 404)
        if route == "/api/preview.png":
            token = (parse_qs(urlparse(self.path).query).get("token") or [""])[0]
            desktop = LAB.desktop
            try:
                info, image = PREVIEW.get(desktop, token)
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
        try:
            payload = self._body()
        except Exception as error:
            return self._json({"ok": False, "message": "请求体无效: %s" % error}, 400)

        if route == "/api/invoke":
            return self._invoke(payload)
        if route == '/api/preview/live':
            # 独立只读路径，不排在 UIA/学习持有的执行锁之后。
            # Desktop 内的预览锁保证 capture 与 close 不会交叉释放资源。
            try:
                info, image = PREVIEW.capture(LAB.desktop)
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
            if REPLAY.busy():
                return self._json({'ok': False, 'error': {'code': 'replay-busy'}}, 409)
            with LOCK:
                try:
                    job_id = REPLAY.start(payload['action'], payload.get('inputs'))
                    return self._json({'ok': True, 'jobId': job_id})
                except ReplayError as error:
                    return self._json({'ok': False, 'error': {'code': str(error)}}, 409)
        if route == "/api/reset":
            with LOCK:
                LAB.log = []
                LAST.clear()
                PREVIEW.clear()
            return self._json({"ok": True, "result": {"message": "日志与画面已清空"}, "state": snapshot()})
        return self._json({"ok": False, "message": "未知动作"}, 404)

    def _invoke(self, payload):
        capability_id = str(payload.get("id") or "")
        arguments = payload.get("arguments") or {}
        if REPLAY.busy():
            return self._json({'ok': False, 'error': {'code': 'replay-busy'}}, 409)
        with LOCK:
            if REPLAY.busy():
                return self._json({'ok': False, 'error': {'code': 'replay-busy'}}, 409)
            try:
                if capability_id.startswith('act.') or capability_id in ('env.hidden.open', 'env.app.launch', 'env.app.close', 'locate.window'):
                    REPLAY.invalidate()
                outcome = LAB.invoke(capability_id, arguments)
                if capability_id in ('observe.capture', 'verify.capture.rendered'):
                    outcome['result'] = publish_preview(outcome['result'])
            except CapabilityError as error:
                LAB.log_line("%s 被拒：%s" % (capability_id, error.code), "error")
                LAST["invoke"] = {"id": capability_id, "ok": False, "error": error.payload()}
                return self._json({"ok": False, "capability": capability_id,
                                   "error": error.payload(), "state": snapshot()})
            except Exception as error:                     # 兜底：绝不吞掉
                LAB.log_line("%s 未预期失败：%s" % (capability_id, error), "error")
                payload_error = {"code": "dispatch-effect-unknown", "kind": "unknown",
                                 "detail": "%s: %s" % (type(error).__name__, error)}
                LAST["invoke"] = {"id": capability_id, "ok": False, "error": payload_error}
                return self._json({"ok": False, "capability": capability_id,
                                   "error": payload_error, "state": snapshot()},
                                  status=500)

            capability = next(c for c in CAPABILITIES if c["id"] == capability_id)
            LAB.log_line("%s 成功（%d ms）" % (capability_id, outcome["elapsedMs"]))
            # 画面文件与桌面同生命周期：这两个动作会让旧 token 彻底失效，必须一起清掉，
            # 否则新会话一建立，页面就会去请求上一轮已删除的图（404）。
            if capability_id in ("env.hidden.open", "env.app.close"):
                PREVIEW.clear()
            elif capability["layer"] in ("execute", "environment"):
                auto_capture()
            LAST["invoke"] = {"id": capability_id, "ok": True, "result": outcome["result"],
                              "elapsedMs": outcome["elapsedMs"]}
            return self._json({"ok": True, "capability": capability_id, **outcome,
                               "state": snapshot()})


def free_port(preferred):
    for port in range(preferred, preferred + 50):
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise SystemExit("找不到可用端口")


def main():
    parser = argparse.ArgumentParser(description="Hidden Desktop 基础能力测试台")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--lease", type=int, default=PAGE_LEASE_SECONDS,
                        help="隐藏桌面租约秒数（1..%d），默认 %d" % (MAX_LEASE, PAGE_LEASE_SECONDS))
    parser.add_argument("--no-browser", action="store_true")
    arguments = parser.parse_args()

    if not 0 < arguments.lease <= MAX_LEASE:
        raise SystemExit("--lease 必须在 1..%d 之间" % MAX_LEASE)
    LAB.lease = arguments.lease

    port = free_port(arguments.port)
    url = "http://127.0.0.1:%d/" % port
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("LAB_URL=" + url, flush=True)
    print("按 Ctrl+C 停止。", flush=True)
    if not arguments.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        REPLAY.shutdown()
        with LOCK:
            if LAB.desktop and LAB.desktop.context:
                try:
                    LAB.desktop.close()
                    print("退出前已清理隐藏桌面。", flush=True)
                except Exception as error:
                    print("退出前清理未确认：%s" % getattr(error, "errors", error), flush=True)
        server.server_close()


if __name__ == "__main__":
    main()
