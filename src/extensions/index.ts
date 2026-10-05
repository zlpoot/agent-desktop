import type { AgentExtension } from "../contracts/extension.js";
import { ExtensionRegistry } from "../contracts/extension.js";
import { createHearthstoneExtension } from "./hearthstone/hearthstone-extension.js";
import { createNeteaseExtension } from "./netease/netease-extension.js";
import { createNteExtension } from "./nte/nte-extension.js";
import { createShopExtension } from "./shop/shop-extension.js";
import { createTestbenchExtension } from "./testbench/testbench-extension.js";

/**
 * 内置业务扩展组装：核心只通过 ExtensionRegistry 消费这些扩展；
 * 禁用全部扩展后，通用任务仍走通用规划、探索与 Workflow 回放路径。
 */
export function createBuiltinExtensions(options: { rootDir: string; appPath?: string }): AgentExtension[] {
  return [
    createNeteaseExtension(options),
    createNteExtension(options),
    createHearthstoneExtension(),
    createShopExtension(),
    createTestbenchExtension(),
  ];
}

/** 内置扩展的默认注册表；装配层与测试用它构造路由基线。 */
export function createDefaultExtensionRegistry(options: { rootDir: string; appPath?: string }): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  for (const extension of createBuiltinExtensions(options)) registry.register(extension);
  return registry;
}
