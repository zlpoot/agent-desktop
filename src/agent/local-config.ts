import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ChatCompletionsModel, type ChatCompletionsOptions } from "./chat-completions-model.js";
import { JevChoiceModel, type JevChoiceOptions } from "./jev-choice-model.js";
import type { ModelProvider } from "../contracts/model-provider.js";
import { HybridVerifier } from "../verifier/hybrid-verifier.js";
import { readPrompt } from "./prompt-store.js";
import type { FacetRegistry } from "../contracts/facets.js";
import type { ContributorRegistry } from "../contracts/verifier-contributor.js";
import { resolveModelSettings } from './model-settings.js';

/** Network capabilities require an explicit HTTP(S) endpoint before execution. */
export function requiredEndpoint(name: 'COMPUTER_USE_BASE_URL' | 'JEV_BASE_URL'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before model execution`);
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${name} requires HTTP(S)`);
  return value;
}

export function configuredVerifier(
  rootDir = process.cwd(),
  registries: { facets?: FacetRegistry; contributors?: ContributorRegistry } = {},
): HybridVerifier | undefined {
  let config: {mode?: string; confidenceThreshold?: number; timeoutMs?: number};
  try { config = JSON.parse(readFileSync(resolve(rootDir, 'config/acceptance-verifier.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (config.mode === 'off') return undefined;
  if (config.mode !== 'assist' && config.mode !== 'shadow') throw new Error('Invalid acceptance verifier mode');
  return new HybridVerifier({baseUrl:requiredEndpoint('JEV_BASE_URL'),
    apiKey:requiredKey(), mode:config.mode, confidenceThreshold:config.confidenceThreshold ?? 0.8,
    timeoutMs:config.timeoutMs ?? 5000, instructions:()=>readPrompt('jev-verifier',rootDir),
    facets: registries.facets, contributors: registries.contributors});
}

function localKey(): string | undefined {
  if (process.env.COMPUTER_USE_API_KEY) return process.env.COMPUTER_USE_API_KEY;
  try {
    const content = readFileSync(resolve(".env.local"), "utf8");
    const line = content.split(/\r?\n/).find((item) => /^\s*COMPUTER_USE_API_KEY\s*=/.test(item));
    return line?.replace(/^\s*COMPUTER_USE_API_KEY\s*=\s*/, "").trim()
      .replace(/^(['"])(.*)\1$/, "$2");
  } catch { return undefined; }
}

function requiredKey(): string {
  const apiKey = localKey();
  if (!apiKey) throw new Error("请设置 COMPUTER_USE_API_KEY 环境变量，或写入项目根目录的 .env.local");
  if (apiKey === "YOUR_API_KEY") {
    throw new Error("请先把 .env.local 中的占位值替换为实际密钥");
  }
  return apiKey;
}

export function configuredModel(options: Pick<ChatCompletionsOptions,
  "allowedHosts" | "taskInstructions" | "environment" | "visualMode"> = {}, rootDir = process.cwd()): { model: ChatCompletionsModel; modelName: string } {
  return modelFromSettings(resolveModelSettings(rootDir), options);
}

function modelFromSettings(settings: ReturnType<typeof resolveModelSettings>, options: Pick<ChatCompletionsOptions,
  'allowedHosts' | 'taskInstructions' | 'environment' | 'visualMode'> = {}) {
  if (settings.reasons.length) throw new Error(settings.reasons.join('；'));
  const { endpoint: baseUrl, model: modelName, apiKey } = settings.effective;
  return { modelName, model: new ChatCompletionsModel({ baseUrl, model: modelName, apiKey, ...options }) };
}

export function configuredJev(options: Pick<JevChoiceOptions,
  "candidateActions" | "confidenceThreshold">): JevChoiceModel {
  const root = requiredEndpoint('JEV_BASE_URL');
  return new JevChoiceModel({ baseUrl: root, apiKey: requiredKey(), model: "jev", ...options });
}

/** ModelProvider 适配器：把环境变量/本地配置封装为契约接口，供装配层注入核心。 */
class LocalModelProvider implements ModelProvider {
  constructor(private readonly rootDir: string, private readonly snapshot?: ReturnType<typeof resolveModelSettings>) {}
  createModel(options?: Parameters<ModelProvider['createModel']>[0]) {
    return modelFromSettings(this.snapshot ?? resolveModelSettings(this.rootDir), options).model;
  }
  snapshotForRun(): ModelProvider { return new LocalModelProvider(this.rootDir, resolveModelSettings(this.rootDir)); }
}
export function configuredModelProvider(rootDir = process.cwd()): ModelProvider {
  return new LocalModelProvider(rootDir);
}
/** Freeze only the local provider; injected Fake/custom providers retain their contract. */
export function snapshotModelProvider(provider: ModelProvider): ModelProvider {
  return provider instanceof LocalModelProvider ? provider.snapshotForRun() : provider;
}
