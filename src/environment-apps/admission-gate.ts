import type { EnvironmentAppRegistry } from '../contracts/environment-apps.js';
import { textValue } from './validation.js';

// Private composition hooks, never a Task/model capability or a serialized boolean.
const gates = new WeakMap<EnvironmentAppRegistry, (id: string) => void>();
export function installAppAdmissionGate(registry: EnvironmentAppRegistry, check: (id: string) => void): void {
  if (gates.has(registry)) throw new Error('app-admission-gate-already-installed');
  gates.set(registry, check);
}
/** Task/input/bridge admission requires a hooked authoritative store on every call.
 * A copied Registry facade cannot carry the original private gate. */
export function assertAppAdmission(registry: EnvironmentAppRegistry, id: string): void {
  textValue(id);
  const check = gates.get(registry);
  if (!check) throw new Error('app-admission-storage-unavailable');
  check(id);
}
/** Frozen legacy P7 launch ports remain supported. A legacy port without this private
 * hook cannot pass assertAppAdmission or become a Task/native input bridge. */
export function assertLegacyAppAdmission(registry: EnvironmentAppRegistry, id: string): void {
  textValue(id); gates.get(registry)?.(id);
}
