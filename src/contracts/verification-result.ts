/** Shared result shapes only; each verifier retains its own policy and reason vocabulary. */
export type VerificationVerdict = 'pass' | 'fail' | 'unknown';

/** Current structured UI evidence carried by acceptance and rebind checks. */
export interface VerificationCheckEvidence {
  source: 'dom' | 'uia';
  target: { role: string; name?: string; text?: string };
  field: string;
  actual?: string | boolean;
  expected: string | boolean;
  captureSequence?: number;
}

export interface VerificationCheck<Reason extends string> {
  criterion: string;
  verdict: VerificationVerdict;
  message: string;
  reason?: Reason;
  evidence?: VerificationCheckEvidence;
}
