"""固定的进程与 TCP 端口查询；不解释或运行调用方命令。"""

import json
import sys
from pathlib import Path

deps_root = Path(__file__).resolve().parents[3] / ".artifacts"
deps = deps_root / f"python-deps-cp{sys.version_info.major}{sys.version_info.minor}"
if not deps.exists():
    legacy = deps_root / "python-deps"
    tag = f"cp{sys.version_info.major}{sys.version_info.minor}"
    if any(legacy.glob(f"PIL/_imaging.{tag}-*.pyd")):
        deps = legacy
if deps.exists():
    sys.path.insert(0, str(deps))

import psutil


def inspect(request):
    kind = request.get("kind")
    number = request.get("number")
    if type(number) is not int or number <= 0 or (kind == "port" and number > 65535):
        raise ValueError("查询参数必须是合法正整数")
    if kind == "process":
        try:
            process = psutil.Process(number)
            return {"pid": process.pid, "name": process.name(), "status": process.status(),
                    "executable": process.exe()}
        except psutil.NoSuchProcess:
            return None
    if kind == "port":
        found = []
        for connection in psutil.net_connections(kind="tcp"):
            if connection.laddr and connection.laddr.port == number:
                found.append({"address": connection.laddr.ip, "port": number,
                              "status": connection.status, "pid": connection.pid})
                if len(found) == 20:
                    break
        return found
    raise ValueError("不支持的系统查询")


try:
    print(json.dumps({"result": inspect(json.loads(sys.stdin.read()))}, ensure_ascii=False))
except Exception as error:
    print(json.dumps({"error": f"{type(error).__name__}: {error}"}, ensure_ascii=False))
