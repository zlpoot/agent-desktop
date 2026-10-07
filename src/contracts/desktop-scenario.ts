import type { Observation } from '../actions/schema.js';

/** Fixed, composition-owned scenario. No planner-selected actions or parameters. */
export interface DesktopScenarioDefinition {
  readonly id: string;
  readonly goal: string;
}
export interface DesktopScenarioVerification {
  readonly verdict: 'pass' | 'pending';
  readonly observation: Observation;
  readonly facts: Readonly<Record<string, string | number | boolean>>;
}
/** One retained Session/target; prepare and preflight never claim input. */
export interface PreparedDesktopScenario {
  preflight(): Promise<void>;
  observe(): Promise<Observation>;
  execute(): Promise<void>;
  /** Independent read after dispatch, never inferred from command ACK. */
  verify(): Promise<DesktopScenarioVerification>;
  close(): Promise<void>;
}
