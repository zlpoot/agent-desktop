# P6-C — Explicit target/scenario selection on the unified control surface

Issue #12; branch `codex/p6-c-target-scenario-ui`; base `d0b74b0278449f53b2c772157b4f4fad8472daec` (P6-B squash merge, PR #14). P6-B was independently accepted at `621b2a9e0edeef5d1d1e80938077f812b6248e24`. This candidate exposes that accepted finite scope; author validation is not independent acceptance or merge authorization.

## Catalog and selection

`GET /api/desktop/environments` retains the P5 Provider/environment identities and generic `executable` flag. Returned environments are discoverable; `executable` describes generic Task/Workflow compatibility, not live readiness. An executor may now supply a read-only `scenarios` catalog with `supported`, `unavailable`, `unsupported` and `not-proven` states. A supported entry is revalidated by the trusted executor before being advertised. If its executor cannot accept it, discovery reports it as unavailable. Duplicate IDs and invalid catalogs fail closed.

The explicitly configured Local Workspace environment advertises exactly one supported entry:

| Environment | Supported ID | Fixed scope |
|---|---|---|
| `local-workspace:fixture` | `d0-fixture-text-click-v1` | Synthetic fixture v1, owned main window, fixed EDIT/BUTTON text and click |
| `local-workspace:netease` | `d0-netease-fixed-track-v1` | NetEase 3.1.40.205461, owned main window, 孙燕姿《我怀念的》 fixed scenario |

Only the configured environment is discoverable. The catalog includes the exact application/version/role and existing D0-D evidence reference, without executable paths, Session identities, HWNDs, observation tokens, grants or Viewer bearer URLs. Disabled boundary entries retain packaged Notepad `unsupported`, RAW isolated input `not-proven` and arbitrary application/Task/Workflow `not-proven`. Those boundary IDs cannot be submitted as executable scenarios.

The catalog is presentation data, not a new capability or authorization gate. Discovery does not open a Session, construct a backend, inspect/acquire input authority, observe a window, launch an application or call a model. It does not prove current target readiness. P6-A scoped capability admission and P6-B execution/verification/cleanup fences remain the actual execution gates.

The Task composer allows selection of an environment and then its fixed scenario. It starts with a blank scenario; it never selects the first scene or parses a goal to select one. Switching environment clears the scene. Drafts retain the exact environment/scenario pair across reload; removed or blocked entries stay blocked rather than falling back. Creating a new draft from a finite Task retains its explicit scene but dispatches nothing until the user submits a new Task.

Free goal text, completion criteria, constraints and the administrator toggle are disabled for finite scenes and absent from their HTTP request. Generic drafts retain their existing behavior. The shared Workflow selector continues to require generic compatibility: finite scene support cannot enable arbitrary Windows Workflow execution. Hyper-V compatibility and Browser routing remain unchanged.

## HTTP submission

`POST /api/desktop/scenarios/tasks` accepts only:

```json
{
  "desktopTarget": {
    "providerId": "windows-local-workspace",
    "environmentId": "local-workspace:fixture"
  },
  "scenarioId": "d0-fixture-text-click-v1"
}
```

An optional existing `budget` override is allowed. Same-origin/local request checks, JSON content type and the existing bounded body parser apply. Missing/unknown identities and scenes, extra target identity fields, arbitrary goal/action/version/administrator fields and invalid budgets are rejected before Task/backend construction. A missing scenario controller returns 503 without calling generic submit. `/api/tasks` rejects scene fields; Workflow trial/execute rejects them as well.

The endpoint calls the existing `submitScenario`, which persists immutable exact selection and supplies the trusted fixed goal. The catalog is not a reusable admission token. Execution still binds a fresh exact Session/instance/target, performs authority-free capability preflight before acquire, observes, dispatches once, verifies independently, then requires confirmed revoke/drain/owned Job+Desktop cleanup before `done`. Continue/recovery cannot replay a finite scene. Run detail returns its stored `desktopScenario` for faithful draft reconstruction.

## Validation

Tests use synthetic configuration, an injected backend behind production composition and local browser pages. They make no real desktop inputs or model calls and access no third-party application or website.

| Check | Author result |
|---|---|
| `npm run check` | PASS |
| New offline catalog/production HTTP tests | 4/4 PASS |
| Final Task/Workflow selection browser tests | 4/4 PASS |
| `npm run test:offline` | 600/600 PASS, zero failures/skips |
| `npm run test:python` | 13/13 contract files PASS |
| `npm run test:browser` | 53/54 PASS; one inherited report-download failure |
| `git diff --check` | PASS |
| Visual check | Production catalog + synthetic composition screenshot inspected; selector uses existing styles |
| Live machine/application/model | NOT RUN; no new live gate authorized |

The full browser suite and a targeted retry both fail at `tests/workflow-library.test.ts:159`, `download.saveAs: canceled`. The same unchanged test was separately run in the accepted P6-B worktree at `621b2a9e0edeef5d1d1e80938077f812b6248e24` and reproduced the identical failure. That test and the relevant baseline report code match the squash-merged P6-C base. The cause is not established and the report code/test is not changed by this candidate. Thus the browser suite is **not fully passing**; the inherited failure remains open. All four selection browser tests pass after the final styling adjustment.

Historical **A5 safety FAIL**, **Windows PAUSED**, Physical generic **not-proven** and overall **INCOMPLETE** remain unchanged. No new live experiment, capability evidence, arbitrary application support, RAW implementation or Workflow/Host/Guest/native protocol change is claimed.
