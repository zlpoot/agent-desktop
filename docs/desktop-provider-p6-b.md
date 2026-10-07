# P6-B — Local Workspace finite scenarios in the Task path

Issue #12; branch `codex/p6-b-local-workspace-scenarios`; base `51a98a479fff5ffb7fbba966448798beb5fc6881`.

P6-A was independently accepted at `e2559d92423514f89501a1fca07cf338f086d9ee`, then squash merged as the base above. This P6-B candidate connects the production Local Workspace provider, P4 D0 runtime and P6-A admission to the existing Task controller, queue, durable trace, Session registry, pause/close lifecycle and budget ledger. Author validation does not constitute independent acceptance or merge authorization.

## Exact scope and entry

`DesktopTaskController.submitScenario({ desktopTarget, scenarioId }, budget?)` is a programmatic, explicit entry. Selection is immutable in Task storage; neither goal text nor a planner can choose or modify the scenario. The fixed goal is supplied by the trusted executor. Root composition registers `LocalWorkspaceTaskExecutor` with `TaskDesktopSessions`; Agent Core does not switch on Provider ID or kind.

| Environment | Scenario ID | Existing evidence and permitted operation |
|---|---|---|
| `local-workspace:fixture` | `d0-fixture-text-click-v1` | D0 synthetic Win32 EDIT/BUTTON: type `hello from agent workspace`, then one click, once |
| `local-workspace:netease` | `d0-netease-fixed-track-v1` | NetEase Cloud Music **3.1.40.205461**, explicit executable configuration, 孙燕姿《我怀念的》, fixed search/navigation/playback script, once |

The provider must already be explicitly configured for that environment. Scenario validation is read-only and runs before worker construction. A Session open creates its owned Job/Desktop/window, without dispatching the input script. Unknown environments, scenario IDs, applications, songs and versions are rejected. Generic Local Workspace Task/Workflow execution remains unavailable. Physical generic admission, Hyper-V compatibility, Workflow schema and Host/Guest/native protocol are unchanged. Environment/target/scenario HTTP and UI selection remain P6-C; no Browser surface is added.

## Target and execution fences

The concrete backend issues a `TargetBinding` with the full Provider/environment/Session/instance/input-resource identity, opaque owned-window target ID, exact application/version and `owned-main-window` role. Binding and preflight read native identity/control/readiness facts without reading, obtaining or renewing input authority. P4 identity confirmation now records the acknowledged native owner/epoch separately from Host grants; management reads no longer inspect those grants. Session readiness also requires actual `control_ready`, and NetEase input requires `input_ready`.

The Task sequence is:

```text
persist explicit scenario selection
→ open and persist exact Session/instance
→ bind target
→ preflight
→ beginTask (fresh preflight immediately before acquire)
→ observe
→ persist dispatch intent
→ execute (fresh P6-A admission)
→ P4 backend admission / Python observation-grant fence / native per-effect identity-epoch-lease fence
→ independent final observation and result check
→ revoke, drain, close and confirm owned Job/Desktop cleanup
→ Task done
```

Both Host and concrete backend directly reuse `assertDesktopCapabilities`; there is no new boolean support gate or reusable authorization token. Trusted requirements map the one configured operation to the existing `input.targetedWindow` / `run-validated-scenario` / `owned-hwnd-message` evidence. The accepted NetEase **Agent** script uses targeted HWND input; its separate Human Viewer ValuePattern capability is not promoted into an arbitrary Agent semantic operation. Pixel/UIA capture, Viewer admission, lease renewal and bounded native script remain the existing P4 implementations.

The backend independently validates current target metadata, instance, Agent grant and the exact retained public observation binding before invoking the old finite runtime. The runtime again checks capability/readiness, authority, freshness and its native observation token; Python consumes that token once and independently validates current grant/epoch/instance/target. A later observation invalidates the previous binding. Concurrent capture/execute/verify operations are refused so a pending admission cannot substitute a different observation; close fences and drains the port as well as its runtime. Raw handles, backend tokens, grants, Viewer bearer URLs and executable configuration do not enter durable Task state. No default-desktop/global-input fallback, implicit rebind, replacement Session or script replay is available.

## Fixed outcome verification and lifecycle

An `act()` response only acknowledges dispatch. It never establishes completion. The independent verifier reads current backend state, captures a new integrity-checked frame, then reads state again. Both reads must satisfy the fixed outcome. Fixture requires native `input=PASS`, progress/total/text length **26**, clicks **1** and no Human actions. NetEase requires native `input=PASS`, progress/total **4**, exact track match, playing and no Human actions. Native text/selection/click/playback effect checks remain unchanged. The result and final observation are stored as `desktopScenarioVerification`; they prove only the explicitly selected finite scenario, not an arbitrary natural-language goal.

Verification polling is read-only and bounded to 45 seconds. It cannot extend D0's existing duration/input/lease budgets. These fixed operations neither plan arbitrary actions nor admit purchase/delete/send/other impact operations; generic risk gates remain intact. The Task model budget is snapshotted as usual, with zero model calls. No workflow is synthesized or promoted.

Dispatch intent is saved before the command. Pause, lost authority, identity/observation drift, ambiguous dispatch or missing completion proof cannot produce `done`; after dispatch they retain uncertainty. Continue/resume rejects finite scenario replay, including after process recovery. An explicit new Task is required. A Task is only marked done after input revocation/drain and owned Job/Desktop cleanup succeed. Every cleanup is attempted; unconfirmed cleanup records failure and the existing P4 arbiter blocks the resource. Preflight failures also close the opened owned workspace without claiming input. Controller shutdown waits for late opens and in-flight runtime drain.

## Validation

All new tests use synthetic data and an injected backend behind the **production** provider/executor/root composition; they perform no OS input, application launch, real model call or third-party access. Tests cover both exact finite scenes, authority-free/expired-grant preflight, refusal before acquire, fresh execute admission, identity drift, forged/replaced observations, independent native grant rejection, false-positive dispatch replies, final-frame ordering, uncertainty, pause/close/drain, cleanup failure and immutable durable scenario selection.

| Check | Author result |
|---|---|
| `npm run check` | PASS |
| New finite scenario tests | 26/26 PASS |
| Targeted P6-A/P4/Task/Physical/recovery regression tests | 104/104 PASS |
| `npm run test:offline` | 596/596 PASS; zero failures/skips; frozen source hashes matched after the final run |
| `npm run test:python` | 13/13 contract files PASS |
| `git diff --check` | PASS |
| Browser | NOT RUN — no UI/HTTP/Browser surface change |
| Real machine / application / model | NOT RUN — no new live gate authorized |

P6-C has not started. Historical **A5 safety FAIL**, **Windows PAUSED** and overall **INCOMPLETE** remain unchanged. This candidate does not claim arbitrary application compatibility, raw isolated input, separate user/profile/files/network/audio isolation, or new live evidence.
