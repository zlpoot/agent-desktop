import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface VmStatus {
  name: string;
  id: string;
  state: string;
  ipv4: string | null;
}

export interface VmControl {
  status(): Promise<VmStatus>;
  start(): Promise<VmStatus>;
  openConsole(): Promise<void>;
}

export class HyperVVmControl implements VmControl {
  constructor(private readonly vmId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(vmId)) {
      throw new Error("VM ID 必须是 UUID");
    }
  }

  private async run(command: string): Promise<string> {
    const script = `$ErrorActionPreference='Stop'; $id=[guid]'${this.vmId}'; ${command}`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    try { const { stdout } = await execFileAsync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 12_000, maxBuffer: 32_768 });
    return stdout.trim();
    } catch (error) {
      console.error("Hyper-V 管理命令失败", error);
      throw new Error("无法读取或管理虚拟机；请检查 Hyper-V 服务及 Dashboard 账户的管理权限。已有 Worker 连接可独立使用。");
    }
  }

  async status(): Promise<VmStatus> {
    const output = await this.run(`$vm=Get-VM -Id $id -ErrorAction Stop;
      $ip=Get-VMNetworkAdapter -VM $vm -ErrorAction Stop |
        ForEach-Object { $_.IPAddresses } |
        Where-Object { $_ -match '^\\d{1,3}(\\.\\d{1,3}){3}$' -and $_ -notmatch '^169\\.254\\.' } |
        Select-Object -First 1;
      [pscustomobject]@{name=$vm.Name;id=$vm.Id.ToString();state=$vm.State.ToString();ipv4=$ip} |
        ConvertTo-Json -Compress`);
    const value = JSON.parse(output) as VmStatus;
    if (value.id.toLowerCase() !== this.vmId.toLowerCase()) throw new Error("VM ID 不匹配");
    return value;
  }

  async start(): Promise<VmStatus> {
    await this.run(`$vm=Get-VM -Id $id -ErrorAction Stop;
      if ($vm.State -eq 'Off') { Start-VM -VM $vm -ErrorAction Stop | Out-Null }
      elseif ($vm.State -ne 'Running') { throw "VM is $($vm.State); wait for the current operation." }`);
    return this.status();
  }

  async openConsole(): Promise<void> {
    const vm = await this.status();
    const child = spawn("vmconnect.exe", ["localhost", vm.name],
      { detached: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.unref();
  }
}
