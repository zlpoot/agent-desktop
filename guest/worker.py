"""D1 observe-only worker. Run inside an interactive Windows guest session."""

import io
import json
import os
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from time import time

import pyautogui


TOKEN = os.environ.get("AGENT_DESKTOP_TOKEN", "")
VM_ID = os.environ.get("AGENT_DESKTOP_VM_ID", socket.gethostname())
PORT = int(os.environ.get("AGENT_DESKTOP_WORKER_PORT", "8765"))
STARTED = time()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if not TOKEN or self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self.send_error(401)
            return
        if self.path == "/state":
            body = json.dumps({"vm_id": VM_ID, "host": socket.gethostname(),
                               "uptime_seconds": int(time() - STARTED),
                               "desktop": os.environ.get("SESSIONNAME", "")}).encode()
            self.reply(200, "application/json", body)
            return
        if self.path == "/frame":
            try:
                image = pyautogui.screenshot()
                output = io.BytesIO()
                image.save(output, format="PNG")
            except Exception as error:
                self.send_error(503, f"desktop capture failed: {error}")
                return
            self.reply(200, "image/png", output.getvalue())
            return
        self.send_error(404)

    def do_POST(self):
        self.send_error(405, "D1 worker is observe-only")

    def reply(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        print(format % args, flush=True)


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("Set AGENT_DESKTOP_TOKEN before starting the guest worker")
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Agent Desktop Worker {VM_ID} listening on port {PORT}", flush=True)
    server.serve_forever()
