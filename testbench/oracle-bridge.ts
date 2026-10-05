import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.txt$/;
const PHONE = /^1\d{10}$/;

export type OracleCheck =
  | { kind: 'todo'; title: string; completed: boolean }
  | { kind: 'testbench-phone'; expected: string }
  | { kind: 'desktop-file'; fileName: string; expectedText: string };
export interface OracleRequest {
  version: 1;
  requestId: string;
  taskId: string;
  requestedAt: string;
  check: OracleCheck;
}
export interface OracleResult {
  version: 1;
  requestId: string;
  taskId: string;
  requestedAt: string;
  check: OracleCheck;
  capturedAt: string;
  status: 'pass' | 'fail' | 'unavailable';
  observed?: unknown;
  reason?: string;
}
interface BridgeConfig { vmName: string; vmId: string }

export function oracleDir(rootDir: string): string {
  return join(rootDir, '.artifacts', 'agent-desktop', 'oracle');
}
export function privateOracleDir(rootDir: string): string {
  return join(rootDir, '.artifacts', 'agent-desktop', 'oracle-private');
}

export function parseOracleRequest(value: unknown): OracleRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || typeof row.requestId !== 'string' || !UUID.test(row.requestId) ||
      typeof row.taskId !== 'string' || !UUID.test(row.taskId) ||
      typeof row.requestedAt !== 'string' || !Number.isFinite(Date.parse(row.requestedAt))) return;
  const check = row.check;
  if (!check || typeof check !== 'object' || Array.isArray(check)) return;
  const item = check as Record<string, unknown>;
  if (item.kind === 'todo' && typeof item.title === 'string' && item.title.length > 0 &&
      item.title.length <= 100 && typeof item.completed === 'boolean') {
    return { version: 1, requestId: row.requestId, taskId: row.taskId, requestedAt: row.requestedAt,
      check: { kind: 'todo', title: item.title, completed: item.completed } };
  }
  if (item.kind === 'testbench-phone' && typeof item.expected === 'string' && PHONE.test(item.expected)) {
    return { version: 1, requestId: row.requestId, taskId: row.taskId, requestedAt: row.requestedAt,
      check: { kind: 'testbench-phone', expected: item.expected } };
  }
  if (item.kind === 'desktop-file' && typeof item.fileName === 'string' && FILE_NAME.test(item.fileName) &&
      !item.fileName.includes('..') && typeof item.expectedText === 'string' && item.expectedText.length <= 4096) {
    return { version: 1, requestId: row.requestId, taskId: row.taskId, requestedAt: row.requestedAt,
      check: { kind: 'desktop-file', fileName: item.fileName, expectedText: item.expectedText } };
  }
}

async function guestOracle(rootDir: string, config: BridgeConfig, request: OracleRequest): Promise<unknown> {
  const script = join(privateOracleDir(rootDir), 'read-guest-oracle.ps1');
  const credential = join(privateOracleDir(rootDir), 'guest-credential.xml');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Name', config.vmName, '-VmId', config.vmId, '-CredentialPath', credential,
    '-Kind', request.check.kind];
  if (request.check.kind === 'testbench-phone') args.push('-Expected', request.check.expected);
  if (request.check.kind === 'desktop-file') args.push('-FileName', request.check.fileName);
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { windowsHide: true, cwd: rootDir });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill(), 45000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (part: string) => {
      stdout += part;
      if (stdout.length > 1048576) child.kill();
    });
    child.stderr.on('data', (part: string) => { stderr = (stderr + part).slice(-2048); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `Guest oracle exited ${code}`));
      try { resolve(JSON.parse(stdout.trim())); }
      catch { reject(new Error('Guest oracle returned invalid JSON')); }
    });
  });
}

export async function runOracle(rootDir: string, config: BridgeConfig, request: OracleRequest,
  todoFetch: typeof fetch = fetch): Promise<OracleResult> {
  const result: OracleResult = { version: 1, requestId: request.requestId, taskId: request.taskId,
    requestedAt: request.requestedAt, check: request.check,
    capturedAt: new Date().toISOString(), status: 'unavailable' };
  try {
    if (request.check.kind === 'todo') {
      const check = request.check;
      const response = await todoFetch('http://127.0.0.1:4174/__state', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Todo fixture HTTP ${response.status}`);
      const rows = await response.json() as unknown;
      if (!Array.isArray(rows)) throw new Error('Todo fixture returned invalid state');
      const matches = rows.filter(row => row && typeof row === 'object' &&
        (row as Record<string, unknown>).title === check.title);
      if (matches.length > 1) {
        result.reason = 'target_ambiguous';
        result.capturedAt = new Date().toISOString();
        return result;
      }
      result.observed = matches[0] ?? null;
      result.status = matches.length === 1 &&
        (matches[0] as Record<string, unknown>).completed === check.completed ? 'pass' : 'fail';
      result.capturedAt = new Date().toISOString();
      return result;
    }
    const observed = await guestOracle(rootDir, config, request);
    result.observed = observed;
    if (!observed || typeof observed !== 'object') throw new Error('Guest oracle returned invalid result');
    const row = observed as Record<string, unknown>;
    if (request.check.kind === 'testbench-phone') {
      if (typeof row.pass !== 'boolean') throw new Error('TestBench verdict missing');
      result.status = row.pass ? 'pass' : 'fail';
    } else {
      if (typeof row.exists !== 'boolean' || (row.exists && typeof row.text !== 'string'))
        throw new Error('Guest file result incomplete');
      result.status = row.exists && row.text === request.check.expectedText ? 'pass' : 'fail';
    }
  } catch (error) {
    result.status = 'unavailable';
    result.reason = error instanceof Error ? error.message.slice(0, 300) : 'oracle_error';
  }
  result.capturedAt = new Date().toISOString();
  return result;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, path);
}

export function startOracleBridge(rootDir: string, vmId: string | undefined,
  execute: typeof runOracle = runOracle): { close(): Promise<void> } | undefined {
  const base = oracleDir(rootDir);
  const configPath = join(privateOracleDir(rootDir), 'bridge.json');
  if (!vmId || !existsSync(configPath)) return;
  let config: BridgeConfig;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')) as BridgeConfig;
    if (!config || config.vmId.toLowerCase() !== vmId.toLowerCase() ||
        !/^[A-Za-z0-9_-]+$/.test(config.vmName)) throw new Error('VM identity mismatch');
  } catch (error) {
    console.error('Oracle bridge disabled:', error instanceof Error ? error.message : error);
    return;
  }
  let closed = false;
  let busy = false;
  let lastHeartbeat = 0;
  let pending: Promise<void> | undefined;
  const processQueue = async () => {
    if (closed || busy) return;
    busy = true;
    try {
      const inbox = join(base, 'requests');
      const outbox = join(base, 'results');
      await mkdir(inbox, { recursive: true });
      await mkdir(outbox, { recursive: true });
      for (const dir of [inbox, outbox]) {
        const entry = await lstat(dir);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Oracle queue directory is not a real directory');
      }
      if (Date.now() - lastHeartbeat > 5000) {
        await atomicJson(join(base, 'bridge-status.json'),
          { state: 'running', vmId, updatedAt: new Date().toISOString() });
        lastHeartbeat = Date.now();
      }
      for (const name of (await readdir(inbox)).sort()) {
        if (closed) break;
        if (!UUID.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) continue;
        const inputPath = join(inbox, name);
        const requestId = name.slice(0, -5);
        const outputPath = join(outbox, name);
        if (existsSync(outputPath)) { await unlink(inputPath); continue; }
        const input = await lstat(inputPath);
        if (!input.isFile() || input.isSymbolicLink()) {
          await unlink(inputPath);
          continue;
        }
        if (input.size > 16384) {
          await atomicJson(outputPath, { version: 1, requestId, status: 'unavailable',
            reason: 'request_too_large', capturedAt: new Date().toISOString() });
          await unlink(inputPath);
          continue;
        }
        let request: OracleRequest | undefined;
        try { request = parseOracleRequest(JSON.parse(await readFile(inputPath, 'utf8'))); }
        catch { /* Invalid input becomes a reported unavailable result. */ }
        let result: unknown;
        try {
          const age = request ? Date.now() - Date.parse(request.requestedAt) : NaN;
          if (!request || request.requestId.toLowerCase() !== requestId.toLowerCase()) {
            result = { version: 1, requestId, status: 'unavailable', reason: 'invalid_request',
              capturedAt: new Date().toISOString() };
          } else if (age < -60000 || age > 300000) {
            result = { version: 1, requestId, taskId: request.taskId, status: 'unavailable',
              reason: 'request_expired', capturedAt: new Date().toISOString() };
          } else result = await execute(rootDir, config, request);
        } catch {
          result = { version: 1, requestId, taskId: request?.taskId, status: 'unavailable',
            reason: 'oracle_error', capturedAt: new Date().toISOString() };
        }
        await atomicJson(outputPath, result);
        await unlink(inputPath);
      }
    } catch (error) {
      console.error('Oracle bridge error:', error instanceof Error ? error.message : error);
    } finally { busy = false; }
  };
  const tick = () => { if (!busy) pending = processQueue(); };
  const timer = setInterval(tick, 1000);
  tick();
  return { async close() {
    closed = true; clearInterval(timer);
    await pending;
    await atomicJson(join(base, 'bridge-status.json'),
      { state: 'stopped', vmId, updatedAt: new Date().toISOString() });
  } };
}
