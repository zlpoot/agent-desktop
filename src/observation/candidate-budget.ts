import type { Observation } from '../actions/schema.js';
import { classifyFixtureEvidence, matchTargetInItems, type FixtureSourceProvenance } from './fixture-gate.js';

/** A5 audit only: never infer saturation from items=500 or incomplete item fields. */
export function classifyCandidateObservation(observation: Observation, target: string,
  source?: FixtureSourceProvenance) {
  const structured = observation.structured;
  const fixture = classifyFixtureEvidence({ target, source, obs: {
    url: observation.url ?? '', pageText: observation.pageText ?? '',
    items: structured?.items ?? [], complete: structured?.complete,
  } });
  const captured = matchTargetInItems(structured?.items ?? [], target).via !== 'none';
  const budget = {
    candidateCount: structured?.candidateCount ?? null,
    retainedCount: structured?.retainedCount ?? structured?.items.length ?? null,
    candidateBudget: structured?.candidateBudget ?? null,
    complete: structured?.complete ?? null,
    budgetSaturated: structured?.budgetSaturated ?? null,
  };
  // C8/C9/insufficient evidence precede any budget diagnosis. Saturation alone
  // cannot prove that a missing target existed on the observed page.
  const reason = !fixture.admissible ? fixture.classification
    : captured ? 'captured'
    : structured?.budgetSaturated === true ? 'observation_budget_exhausted'
    : 'observation_evidence_gap';
  return { reason, captured, fixture, budget };
}
