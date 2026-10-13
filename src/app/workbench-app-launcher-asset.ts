import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let compiled: Buffer | undefined;

/** Compile only the extracted browser component. Shared by ordinary startup and fixtures. */
export function workbenchAppLauncherAsset(): Buffer {
  if (compiled) return compiled;
  const configPath = fileURLToPath(new URL('../../tsconfig.workbench-app.json', import.meta.url));
  const require = createRequire(import.meta.url);
  const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
  const assets = fileURLToPath(new URL('../../.artifacts/frontend/', import.meta.url));
  mkdirSync(assets, { recursive: true });
  // Each process owns its fresh output directory; concurrent fixtures cannot read partial JS.
  const output = mkdtempSync(join(assets, 'workbench-app-'));
  try {
    const result = spawnSync(process.execPath, [compiler, '-p', configPath, '--noEmit', 'false', '--outDir', output], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(`workbench-app-compile-failed: ${result.stdout}${result.stderr}`);
    compiled = readFileSync(join(output, 'app/public/workbench-app-launcher.js'));
    return compiled;
  } finally { rmSync(output, { recursive: true, force: true }); }
}
