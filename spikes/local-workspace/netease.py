"""Opt-in installed NetEase preflight and bounded song selection policy."""
import json
from pathlib import Path
import subprocess
from policy import Blocked


def preflight(config):
    if not config or not config.get("path"):
        raise Blocked("netease_explicit_path_required")
    for field in ("song", "artist"):
        value = config.get(field)
        if not isinstance(value, str) or not 1 <= len(value) <= 80 or any(ord(c) < 32 or ord(c) > 65535 for c in value):
            raise Blocked("netease_bounded_bmp_query_required")
    path = Path(config["path"]).resolve()
    if path.name.lower() != "cloudmusic.exe" or not path.is_file():
        raise Blocked("netease_installed_executable_required")
    # Read the explicit path from an environment variable, never interpolate
    # user paths into the fixed PowerShell source.
    command = ("$ErrorActionPreference='Stop'; $p=$env:AGENT_D0C_EXE; "
               "$s=Get-AuthenticodeSignature -LiteralPath $p; $f=Get-Item -LiteralPath $p; "
               "$n=@(Get-Process -Name cloudmusic,cloudmusic_reporter,cloudmusic_util -ErrorAction SilentlyContinue).Count; "
               "@{signature=$s.Status.ToString();product=$f.VersionInfo.ProductName;version=$f.VersionInfo.FileVersion;existing=$n}|ConvertTo-Json -Compress")
    import os
    import shutil
    env = {**os.environ, "AGENT_D0C_EXE": str(path)}
    # The host shell may be PowerShell 7; its inherited module path can shadow
    # Windows PowerShell 5.1 built-ins. Use only the installed system modules.
    launcher = shutil.which("pwsh") or str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe")
    env["PSModulePath"] = str(Path(launcher).parent / "Modules")
    command = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " + command
    result = subprocess.run([launcher, "-NoProfile", "-NonInteractive", "-Command", command],
                            capture_output=True, text=True, encoding="utf-8", timeout=8, env=env,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise Blocked("netease_preflight_unavailable")
    try:
        probe = json.loads(result.stdout)
    except ValueError:
        raise Blocked("netease_preflight_invalid")
    if probe.get("signature") != "Valid" or probe.get("product") != "NetEase Cloud Music":
        raise Blocked("netease_installed_signature_or_product")
    if probe.get("existing") != 0:
        raise Blocked("netease_existing_instance_exit_first")
    return {"path": str(path), "version": probe["version"], "song": config["song"], "artist": config["artist"],
            "query": config["artist"] + " " + config["song"]}


def exact_song_row(name, song, artist):
    import re
    # The installed CEF app replaces the selected result's row number with
    # its accessible "play" icon, even while the mini-player is paused.
    if not re.match(r"^(?:\d{1,3}|play)\s+", name): return False
    row = re.sub(r"^(?:\d{1,3}|play)\s+", "", name).strip()
    if not row.startswith(song + " "): return False
    details = row[len(song) + 1:]
    return (details.split()[0] in ("jymaster", "sky", "Tag:") and
            artist in details.split() and "Tag: 原唱" in details and
            not re.search(r"翻唱|伴奏|卡拉OK|原唱[:：]|\(Live\)", row))
