import type { Context, FiberLike, Plugin } from 'cordis';
import type { ExtensionRegistry } from '../contracts/extension.js';

const records = new WeakMap<Context, Array<{ name: string; scope: string; services: string[]; dependencies: string[]; fiber: FiberLike }>>();
const states = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'];

/** Observe assembly fibers without serializing configuration, credentials, or service objects. */
export function mountInspected(root: Context, plugin: Plugin, scope = 'Root', services: string[] = []) {
  const fiber = root.plugin(plugin);
  const entries = records.get(root) ?? [];
  entries.push({ name: plugin.name || 'anonymous', scope, services,
    dependencies: Array.isArray(plugin.inject) ? [...plugin.inject] : Object.keys(plugin.inject ?? {}), fiber });
  records.set(root, entries);
  return fiber;
}

export function inspectAssembly(root: Context, extensions?: ExtensionRegistry) {
  return {
    available: true,
    capturedAt: new Date().toISOString(),
    plugins: (records.get(root) ?? []).map(({ fiber, ...metadata }, index) => ({
      ...metadata, id: index + 1, state: states[fiber.state] ?? 'unknown',
    })),
    extensions: (extensions?.listExtensions() ?? []).map(extension => ({
      id: extension.id, name: extension.name ?? extension.id,
      dependsOn: [...(extension.dependsOn ?? [])],
      capabilities: (extension.capabilities ?? []).map(item => item.id),
      profiles: (extension.profiles ?? []).map(item => item.id),
    })),
  };
}

export type AssemblySnapshot = ReturnType<typeof inspectAssembly>;
