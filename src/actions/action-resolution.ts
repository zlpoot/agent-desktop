export interface ProviderCandidate {
  provider: string;
  available: boolean;
  reason: string;
}

/** 对当前已定位动作的只读解析；执行结果会另记实际提供者。 */
export interface ActionResolution {
  selected: string;
  reason: string;
  candidates: ProviderCandidate[];
}

export function singleProvider(provider: string, reason: string): ActionResolution {
  return { selected: provider, reason,
    candidates: [{ provider, available: true, reason }] };
}
