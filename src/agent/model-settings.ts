import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

type Source = 'environment' | 'private-file' | 'env-local' | 'none';
interface PrivateModelSettings { endpoint?: string; model?: string; apiKey?: string | null }
export const modelSettingsPath = (rootDir: string) => resolve(rootDir, 'config/model.local.json');
const fail = (message: string): never => { throw new Error(message); };

function text(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) fail(`${label}无效`);
  return (value as string).trim();
}
function endpoint(value: unknown): string {
  const result = text(value, 2048, 'API 地址');
  if (!result) return '';
  try {
    const url = new URL(result);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw Error();
  } catch { fail('API 地址须为 HTTP(S)，不能包含凭据、查询或片段'); }
  return result;
}
function model(value: unknown): string {
  const result = text(value, 200, '模型名称');
  if (result === 'jev') fail('JEV 不属于普通 Chat Completions 模型配置');
  return result;
}
function key(value: unknown): string {
  const result = text(value, 2048, 'API Key');
  if (!result || result === 'YOUR_API_KEY') fail('API Key 不能为空或占位值');
  return result;
}
function privateSettings(rootDir: string): PrivateModelSettings {
  try {
    const content = readFileSync(modelSettingsPath(rootDir), 'utf8');
    if (content.length > 8192) throw Error();
    const value = JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(name => !['endpoint', 'model', 'apiKey'].includes(name))) throw Error();
    return { ...(value.endpoint === undefined ? {} : { endpoint: endpoint(value.endpoint) }),
      ...(value.model === undefined ? {} : { model: model(value.model) }),
      ...(value.apiKey === undefined ? {} : { apiKey: value.apiKey === null ? null : key(value.apiKey) }) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return fail('本机模型配置无法读取；请检查私有文件');
  }
}
function envLocalKey(rootDir: string): string | undefined {
  try {
    const content = readFileSync(resolve(rootDir, '.env.local'), 'utf8');
    return content.split(/\r?\n/).find(line => /^\s*COMPUTER_USE_API_KEY\s*=/.test(line))
      ?.replace(/^\s*COMPUTER_USE_API_KEY\s*=\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return fail('.env.local 无法读取');
  }
}

/** Host-only credentials; never place this object in Task/Workflow/HTTP state. */
export function resolveModelSettings(rootDir: string) {
  const saved = privateSettings(rootDir);
  const envEndpoint = process.env.COMPUTER_USE_BASE_URL?.trim();
  const envModel = process.env.COMPUTER_USE_MODEL?.trim();
  const envKey = process.env.COMPUTER_USE_API_KEY?.trim();
  const fallback = !envKey && saved.apiKey === undefined ? envLocalKey(rootDir) : undefined;
  const sources: Record<'endpoint' | 'model' | 'apiKey', Source> = {
    endpoint: envEndpoint ? 'environment' : saved.endpoint ? 'private-file' : 'none',
    model: envModel ? 'environment' : saved.model ? 'private-file' : 'none',
    apiKey: envKey ? 'environment' : saved.apiKey !== undefined ? 'private-file' : fallback ? 'env-local' : 'none',
  };
  const effective = { endpoint: envEndpoint || saved.endpoint || '', model: envModel || saved.model || '',
    apiKey: envKey || saved.apiKey || fallback || '' };
  const reasons: string[] = [];
  try { if (!endpoint(effective.endpoint)) reasons.push('缺少 API 地址（COMPUTER_USE_BASE_URL）'); }
  catch { reasons.push('API 地址无效；须为无凭据的 HTTP(S) 地址'); }
  try { if (!model(effective.model)) reasons.push('缺少模型名称（COMPUTER_USE_MODEL）'); }
  catch { reasons.push('普通 Chat Completions 模型名称无效'); }
  try { key(effective.apiKey); } catch { reasons.push('缺少有效 API Key（COMPUTER_USE_API_KEY）'); }
  return { saved, effective, sources, reasons };
}
export function readModelSettings(rootDir: string) {
  const { saved, effective, sources, reasons } = resolveModelSettings(rootDir);
  // Invalid legacy values may contain credentials: only return validated display fields.
  let safeEndpoint = '', safeModel = '';
  try { safeEndpoint = endpoint(effective.endpoint); } catch { /* reason above */ }
  try { safeModel = model(effective.model); } catch { /* reason above */ }
  let keyConfigured = false;
  try { key(effective.apiKey); keyConfigured = true; } catch { /* reason above */ }
  return { saved: { endpoint: saved.endpoint ?? '', model: saved.model ?? '',
      keyConfigured: !!saved.apiKey, keyCleared: saved.apiKey === null },
    effective: { endpoint: safeEndpoint, model: safeModel, keyConfigured, sources, ready: reasons.length === 0, reasons },
    appliesTo: 'next-task-start' };
}
export function saveModelSettings(rootDir: string, body: Record<string, unknown>) {
  if (Object.keys(body).some(name => !['endpoint', 'model', 'keyAction', 'apiKey'].includes(name))) fail('模型设置字段无效');
  const action = body.keyAction;
  if (!['keep', 'replace', 'clear'].includes(action as string) ||
      (action !== 'replace' && body.apiKey !== undefined)) fail('请选择保留、替换或清除 API Key');
  const previous = privateSettings(rootDir);
  const next: PrivateModelSettings = { endpoint: endpoint(body.endpoint), model: model(body.model),
    ...(action === 'clear' ? { apiKey: null } : action === 'replace' ? { apiKey: key(body.apiKey) } :
      previous.apiKey === undefined ? {} : { apiKey: previous.apiKey }) };
  const path = modelSettingsPath(rootDir), temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch { fail('模型配置保存失败；未确认写入，请重新读取'); }
  finally { rmSync(temporary, { force: true }); }
  return readModelSettings(rootDir);
}
