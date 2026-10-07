import { readFileSync } from 'node:fs';
import type { PhysicalInputPolicy } from '../runtime/desktop/desktop-runtime.js';
import type { LocalWorkspaceAppConfig } from '../desktop-provider/local-workspace-provider.js';

/** Composition-owned operator configuration. Loading never opens a desktop or grants input. */
export function loadDesktopEnvironmentConfig(path?: string): {
  physicalInputPolicy?: PhysicalInputPolicy; localWorkspace?: LocalWorkspaceAppConfig;
} {
  if (!path) return {};
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some(key => !['physicalInputPolicy', 'localWorkspace'].includes(key))) {
    throw new Error('invalid-desktop-environment-config');
  }
  const policy = config.physicalInputPolicy;
  if (policy !== undefined && (!policy || typeof policy.windowManagement !== 'boolean' ||
      !Array.isArray(policy.executors) || policy.executors.some((value: unknown) => typeof value !== 'string' || !value.trim()) ||
      Object.keys(policy).some(key => !['windowManagement', 'executors'].includes(key)))) {
    throw new Error('invalid-physical-input-policy');
  }
  const workspace = config.localWorkspace;
  if (workspace !== undefined && (!workspace || typeof workspace !== 'object' || Array.isArray(workspace) ||
      !['fixture', 'netease'].includes(workspace.app) ||
      Object.keys(workspace).some(key => !(workspace.app === 'fixture' ? ['app'] : ['app', 'path', 'song', 'artist']).includes(key)) ||
      workspace.app === 'netease' && (typeof workspace.path !== 'string' || !workspace.path.trim() ||
        workspace.song !== '我怀念的' || workspace.artist !== '孙燕姿'))) {
    throw new Error('invalid-local-workspace-config');
  }
  return { ...(policy ? { physicalInputPolicy: policy } : {}), ...(workspace ? { localWorkspace: workspace } : {}) };
}
