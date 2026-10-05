import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

test("D1 PowerShell scripts parse in Windows PowerShell 5.1", {
  skip: process.platform !== "win32",
}, () => {
  const vm = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    resolve("scripts/agent-desktop-vm.ps1"), "-Name", "AgentDesktopTest",
    "-IsoPath", "nonexistent-windows-installer.iso", "-NewVhdPath", "D:\\VMs\\AgentDesktopTest.vhdx"],
  { encoding: "utf8" });
  assert.match(vm.stdout + vm.stderr, /ISO file not found/);
  assert.doesNotMatch(vm.stdout + vm.stderr, /ParserError|UnexpectedToken/);

  const guest = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    resolve("guest/start-worker.ps1")], { encoding: "utf8",
    env: { ...process.env, AGENT_DESKTOP_TOKEN: "", AGENT_DESKTOP_VM_ID: "" } });
  assert.match(guest.stdout + guest.stderr, /Set AGENT_DESKTOP_TOKEN/);
  assert.doesNotMatch(guest.stdout + guest.stderr, /ParserError|UnexpectedToken/);

  for (const path of ["guest/worker.ps1", "guest/install-worker-autostart.ps1",
    "guest/install-action-worker.ps1",
    "guest/python-command.ps1",
    "scripts/copy-agent-desktop-guest.ps1", "scripts/start-agent-desktop-dashboard.ps1",
    "scripts/install-agent-desktop-host-autostart.ps1"]) {
    const parsed = spawnSync("powershell.exe", ["-NoProfile", "-Command",
      "$tokens=$null; $errors=$null; " +
      `[System.Management.Automation.Language.Parser]::ParseFile('${resolve(path).replaceAll("'", "''")}', [ref]$tokens, [ref]$errors) | Out-Null; ` +
      "if ($errors.Count -gt 0) { $errors | Out-String | Write-Output; exit 1 }"],
    { encoding: "utf8" });
    assert.equal(parsed.status, 0, `${path}: ${parsed.stdout}${parsed.stderr}`);
  }
});

test("D2 Python discovery invokes a real runtime through PowerShell 5.1", {
  skip: process.platform !== "win32",
}, () => {
  const helper = resolve("guest/python-command.ps1").replaceAll("'", "''");
  const script = `. '${helper}'; $python = Find-AgentDesktopPython; ` +
    `if (-not $python) { throw 'no runtime' }; $pythonArgs = $python.Prefix; ` +
    `& $python.Exe @pythonArgs -c 'import sys; sys.exit(0)'; exit $LASTEXITCODE`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass",
    "-Command", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
