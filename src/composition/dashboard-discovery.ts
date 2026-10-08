import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { WindowsAppCollector } from '../environment-apps/collectors.js';
import { createDashboardPreflight } from './dashboard-preflight.js';

/** Trusted fixed helper, identity only. No application inventory at startup. */
export function readDashboardInstallationIdentity(python: string, script: string): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn(python, [script], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let size = 0, settled = false;
    const finish = (identity?: string) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (identity) accept(identity);
      else { child.kill(); reject(new Error('windows-app-identity-unavailable')); }
    };
    const timer = setTimeout(() => finish(), 3000);
    child.on('error', () => finish()); child.stderr.on('data', () => {});
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length; if (size > 4096) finish(); else chunks.push(chunk);
    });
    child.on('close', code => {
      if (settled) return;
      try {
        const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        finish(code === 0 && !reply.error && /^windows:[a-f0-9]{64}$/.test(reply.installationScopeId)
          ? reply.installationScopeId : undefined);
      } catch { finish(); }
    });
  });
}

/** Only the operator CLI calls this production factory. No native Session or launch port. */
export function createDashboardDiscovery(configPath: string, rootDir: string, python: string) {
  return createDashboardPreflight(configPath, rootDir, undefined, {
    identity: () => readDashboardInstallationIdentity(python, resolve(rootDir, 'scripts/dashboard-app-identity.py')),
    collector: scope => new WindowsAppCollector(scope, python, resolve(rootDir, 'guest/app_discovery.py')),
  });
}
