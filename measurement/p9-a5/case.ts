import type { Layer } from './sidecar.js';
export interface Case {
  caseId:string;pairId:string|null;family:string;backup:boolean;layer:Layer|null;seedId:string;
  input:Record<string,string>;goal:string;initialUrl:string;expectedOutcome:'complete'|'safe_reject';
  contract:{sourceUrl:string;sourceScope?:'exact_page'|'same_origin';displayText:string;destinationPaths:string[];dispatchGuard:string};
  completionContract:{urlIncludes:string;pageTextIncludes:string};inputDelta:boolean;
  provenance:string[];coverageRequirement:string|null;
}
