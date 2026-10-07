# P5-B Unified desktop selection and executor routing

Review base: current `main` `612adb6915e4d5cf06bd3eb6f96c6160d3cb9ac1`, the merged P5-A PR #10. Its tree is identical to the original implementation base `940db60dd54461e31fcb513a6431d4d0dc596d34`. This work is isolated on `codex/p5-b-unified-routing`.

Status: **P5-B ACCEPTED / NARROW RE-REVIEW PASS** (2026-10-07; disposition recorded on PR #11). Independent review found and then closed one blocker: Physical policy had been treated as generic capability admission. The accepted follow-up keeps the managed Physical executor/renewal implementation but makes generic Physical Task/Workflow routing fail closed while Physical input remains `not-proven`. Historical A5 `safety FAIL`, Windows `PAUSED`, and overall `INCOMPLETE` remain unchanged.

## Selection and routing

`GET /api/desktop/environments` discovers exact `{ providerId, environmentId, kind, executable, blockedReason? }` options through the Task registry. Discovery never opens a Session, starts a backend, claims input, or calls a model. Native handles, endpoints, input resources and grants are absent. Mismatched or duplicate discovery identities reject.

`executable` is a conservative generic-Task admission signal. It requires an available executor and any pre-Session admission gate to pass; it does not claim current runtime readiness. Physical remains `executable: false` while its required input capabilities are `not-proven`, even when operator policy allows a mechanism. The legacy VM Viewer remains a separate compatibility view and cannot choose or replace a Task's environment.

The Task form selects Browser or an exact desktop environment. Windows Workflow execute/trial uses the same selector and sends `desktopTarget`; Browser Workflow execute/trial sends no desktop selection and does not depend on the legacy VM control state. Fixed version, preview hash, typed parameters and budget overrides remain intact. Missing or unsupported executors reject before Session acquisition. The old `host`/`guest` API values are retained as compatibility syntax, with the existing explicit-target requirements; new UI requests use `browser`/`desktop`.

Task drafts retain both desktop identity dimensions. A removed environment remains an unavailable selection until the operator chooses another; it never falls back to the first environment. Legacy draft text is preserved but the old host/guest selection must be explicitly replaced. Rebuilding a draft uses the Task's recorded target, preserving ordinary `VM:` text. Historical desktop provenance without a target requires a new selection. Selection is never inferred from goals or the current Viewer.

The existing immutable execution binding and exact retained-Session continuation rules remain in force. New generic route records use the planner's structured `windows`/`browser` environment; the selected Provider is represented by the binding rather than an `agent_desktop` label. Historical `agent_desktop` continuation remains compatible.

## Executor boundaries

| Environment | Task route |
| --- | --- |
| Hyper-V | Existing bound compatibility executor; Guest-specific application catalog stays in composition |
| Physical | Discoverable, but generic Task/Workflow execution remains refused with `physical-task-capability-not-proven`; policy alone is not capability evidence |
| Local Workspace | Discoverable when configured; generic Task/Workflow execution refused because P4 exposes only finite validated scenarios |
| Unknown/unregistered executor | Refused; no native/Worker/first-environment fallback |

The managed Physical executor remains as a lower-level runtime path for future capability-admitted use. When such a caller has independently established scoped support, it acquires the resource arbiter's full Agent authority before runtime construction; every operation still passes through the Physical Provider's session, backend identity, readiness, observation, policy and selected-executor fences, and the native Worker independently checks the grant. P5-B itself does not claim the missing target-scoped Physical evidence and therefore does not expose this path to generic Tasks/Workflows.

Managed Task heartbeats run every second while their runtime is alive. Renewal requires a fresh backend handshake and an unexpired Host authority. The native `physical_renew` checks exact installed authority, current immutable resource identity, readiness and the backend's monotonic deadline; each extension remains capped at three seconds. Expired, revoked, foreign or replaced grants cannot renew. Failed heartbeat closes the runtime; a lost native renewal ACK also invalidates the Session binding. No automatic rebind or resume occurs. Runtime close, task finish, Session revoke and shutdown stop the heartbeat. Lost revoke ACKs keep resources blocked, including manual completion. Old Physical backends without renewal support reject before planning.

Local Workspace's D0 scenarios and scoped capability evidence are unchanged. This checkpoint does not create a generic D0 action API or allow arbitrary Local Workspace Workflows. Physical policy permission also does not convert `not-proven` capability evidence into proven application support.

The exact diff includes existing native/control/authority behavior changes: `physical_renew` dispatch and monotonic renewal in the local Worker, Host renewal admission in `physical-provider.ts`, and Task heartbeat/teardown in `physical-task-executor.ts`. These are explicit independent-review targets; this PR must not be described as changing selection alone. No new live gate is run during materialization. Whether these changes need additional live acceptance remains for the independent reviewer and subsequent explicit authorization.

## Operator configuration

The Dashboard optionally reads the operator-owned JSON file named by `AGENT_DESKTOP_ENVIRONMENT_CONFIG`. [Example](../config/desktop-environments.example.json) keeps Physical input closed. No file means closed Physical policy and no configured Local Workspace. `physicalInputPolicy` supports `windowManagement` and an explicit `executors` allowlist; it authorizes mechanisms but does not make generic Physical Tasks executable. `localWorkspace` uses the existing bounded Provider configuration. Invalid configuration fails startup. The same options remain injectable through `createRootAssembly` for synthetic harnesses. Loading configuration does not start a desktop or authorize a real experiment.

## Validation

Required: `npm run check`, `npm run test:offline`, `npm run test:python`, `npm run test:browser`. New synthetic coverage exercises lazy discovery, exact UI payloads, draft persistence/removal, Browser Workflow routing without VM readiness, configured Physical generic rejection before planning, lower-level managed Physical lifecycle/renewal contracts, retained bindings, lease expiry, old renewal protocol, lost renewal/revoke ACKs, backend replacement, competing Sessions and finite Local Workspace rejection.

The inherited Windows `workflow-library.test.ts` report download failure (`download.saveAs: canceled`) remains visible. P5-A documented the identical failure on its unchanged P4 base. Selection, preview, execution and trial assertions preceding that download pass; the download test is neither skipped nor weakened.

Author validation before the narrow admission fix, on review head `b4d34507d9e37998a3b80615699edef10333ef99`:

| Check | Result |
| --- | --- |
| `npm run check` | PASS |
| `npm run test:offline` | 540/540 PASS |
| `npm run test:python` | All 13 contract files PASS |
| `npm run test:browser` | 51/52 PASS; inherited report download failure |
| Final affected UI/Workflow/budget suites after draft/feedback polish | 9/10 PASS; same report download failure |
| Physical Task routing contracts | 8/8 PASS |
| `git diff --check` | PASS |

The follow-up code head `1ec1481e15644efb45415ab7912069c23d6579d0` received a narrow independent re-review PASS. That review verifies the new fail-closed Physical generic admission regression and its exact code delta; it does not claim a fresh rerun of the full command matrix. No live experiment was added.

Browser regression is not fully green. The new Task and Browser Workflow UI tests pass, and the Windows Workflow target, fixed-version execution and trial assertions pass before the retained download failure. No unrelated download workaround is included.

No real model, third-party site, desktop application, VM, Viewer takeover or Windows experiment was run.
