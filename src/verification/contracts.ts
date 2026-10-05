/** Portable verification contracts. No application names, action execution or model provider dependency. */
export type Verdict = 'pass' | 'fail' | 'unknown';
export type Scalar = string | number | boolean;
export type EvidenceSource = 'dom' | 'uia' | 'window' | 'file' | 'api' | 'visual_model';
export interface Evidence {
  id: string;
  session: string;
  object: string;
  field: string;
  value: Scalar;
  source: EvidenceSource;
  capturedAt: number;
  /** Collector supplied object version; UI text must not manufacture this identity. */
  revision?: string;
  /** Is the whole field observed? A truncated field cannot prove equality or absence. */
  complete: boolean;
}
export type Predicate =
  | { op: 'equals'; expected: Scalar }
  | { op: 'contains'; expected: string }
  | { op: 'atMost'; expected: number }
  | { op: 'changed' }
  | { op: 'outcome'; success: Scalar[]; failure: Scalar[]; pending: Scalar[] }
  | { op: 'semantic'; instruction: string };
export interface Criterion {
  id: string;
  requirement: string;
  object: string;
  field: string;
  predicate: Predicate;
  sources: EvidenceSource[];
  revision?: string;
  /** Two samples means two distinct capture times, not duplicated records. */
  samples?: number;
}
export interface VerificationContract {
  id: string;
  scope: 'action' | 'stage' | 'task';
  /** Coverage must be supplied by the planner/user; the verifier cannot recover omitted natural-language goals. */
  requirements: string[];
  criteria: Criterion[];
}
export interface VerificationInput {
  contract: VerificationContract;
  /** Trusted, independently frozen requirements, captured before execution planning.
   * Never derive this from the candidate contract being checked. */
  specification?: VerificationContract;
  session: string;
  now: number;
  /** Earliest acceptable result observation, usually action dispatch time. */
  notBefore: number;
  evidence: Evidence[];
  before?: Evidence[];
  execution?: 'dispatched' | 'failed' | 'uncertain';
}
export interface Policy {
  maxAgeMs: number;
  modelTimeoutMs: number;
  maxModelBytes: number;
  confidenceThreshold: number;
  allowModelPass: boolean;
}
export interface SemanticQuestion {
  id: string; instruction: string; evidence: Evidence[];
  /** Optional validated context for richer JEV experiments; never expected labels or case rationales. */
  context?: {criterion:Criterion;scope:VerificationContract['scope'];execution?:VerificationInput['execution'];
    before:Evidence[];related:Evidence[];rules:Array<{id:string;verdict:Verdict;reason:string}>};
}
export interface AuxiliaryResult {
  answers: Array<{ id: string; verdict: Verdict; confidence: number }>;
  usage?: { inputTokens?: number; outputTokens?: number };
}
export interface AuxiliaryVerifier {
  evaluate(questions: SemanticQuestion[], signal: AbortSignal): Promise<AuxiliaryResult>;
}
export interface Check {
  id: string;
  verdict: Verdict;
  reason: string;
  evidenceIds: string[];
  method: 'rule' | 'model';
  advisory?: { verdict: Verdict; confidence: number };
}
export interface VerificationReport {
  contractId: string;
  scope: VerificationContract['scope'];
  verdict: Verdict;
  checks: Check[];
  next: 'complete' | 'collect_evidence' | 'review';
  /** Suggestions only: this module has no ability to dispatch any desktop action. */
  missing: Array<{ criterion: string; object: string; field: string; sources: EvidenceSource[] }>;
  metrics: { durationMs: number; modelCalls: number; modelBytes: number;
    inputTokens: number; outputTokens: number; usageReported: boolean };
}
