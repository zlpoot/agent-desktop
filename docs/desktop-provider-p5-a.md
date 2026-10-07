# P5-A Task selection and immutable execution binding

Base: merge `75cd0921df3e4941d5a1542dddd92b25eba5b03f` (accepted P4).

## Contract and execution

`desktopTarget(providerId, environmentId)` constructs an explicit, immutable Task selection. New generic requests persist `taskBindingVersion: 1` and this selection at submission. Omitting the selection permits a browser task; a Windows plan is rejected before application launch or native desktop access. `VM:` is ordinary goal text and provides no environment identity. The backend does not add a VM prefix or translate `destination: guest` into a default desktop: it requires `desktopTarget`. No UI files are changed.

Explicit Workflow execution validates `request.destination` against the pinned `workflow.environment` and persists that structured route at submission. Windows Workflows require a validated `desktopTarget`; Browser execute/trial accepts no target and rejects a supplied target before queuing or Session acquisition. Workflow goals retain their instantiated task text without a routing prefix. Browser Workflows use their fixed plan and strict replay directly, preserving the selected version, typed inputs, completion conditions and trial accounting across pause/continue. Windows window planning cannot change the Workflow environment; a conflicting plan fails before application launch or replay.

Before input ownership, window discovery, planning or runtime connection, `TaskDesktopSessions` resolves the exact registered Provider and discovered environment, opens its Session, validates backend identity and status, and persists `desktopExecutionBinding: { providerId, environmentId, sessionId, instanceId }`. This is distinct from the existing HWND/process `desktopBinding` and runtime-owned target/observation identities. The Task binding contains no native handle, Worker URL, token, grant or input resource identifier.

The registry uses injected Provider/executor ports. Core has no Provider-id/kind switch and no host/Worker fallback. Production composition connects only the existing Hyper-V compatibility executor. Physical and Local Workspace remain discoverable Providers but reject Task execution with `desktop-task-executor-unavailable`; adding their executor routing is P5-B. Legacy specialized Windows executors are rejected at Task Controller submission rather than bypassing binding. A selected desktop request continues through the existing generic desktop execution path, risk gates, verification and budgets.

Selection and execution binding are readonly contracts, copied and frozen at acquisition, and carried in trace snapshots and LangGraph checkpoint channels. Trace writes compare against the persisted state within an immediate SQLite transaction and reject erasure or replacement of target, binding, version and compatibility provenance. Checkpoint reducers reject replacement as well. Browser selection cannot acquire a desktop target later. Runtime adapters retain their independent backend identity and authority fences.

Continue/resume uses the retained exact Session. Provider, environment, session or instance changes fail closed. Missing Sessions, including loss across a Host process restart, return `desktop-binding-unavailable`; they do not open a replacement. An operator can explicitly submit a new Task, preserving the original Task/checkpoint and uncertain-action evidence. Recovery of the same retained binding still observes/reconciles before execution, keeps checkpoint lineage, retry/model budgets, workflow version and file verification gates. Serialized desktop observations do not restore authority.

Task close rejects new acquisition, drains pending opens, closes late Sessions and reports cleanup failures. Scope unload identifies the actual lifecycle control through the injected executor port, pauses/drains its running Task, and then releases infrastructure. Manual completion uses the original binding and reserves the existing input resource while clearing its parked legacy Task; it never grants Agent input. Failed completion/cleanup remains resource-blocking.

## Historical compatibility

| Persisted historical evidence | Compatibility behavior |
| --- | --- |
| Generic `browser` route, no conflicting desktop provenance | Existing browser continuation; no inferred desktop target |
| Generic `agent_desktop` route with saved VM identity | `adoptLegacyDesktopTask(taskId, desktopTarget(...))` must be called explicitly; composition verifies target against saved VM identity |
| Generic `windows` route | Requires explicit compatibility selection and a validating executor; production P5-A has no Physical Task executor, so submit a new supported Task or await P5-B |
| Missing/unknown route, queued goal text only, or desktop origin without verifiable identity | Reject continuation/migration; explicitly resubmit |
| Historical specialized desktop/unknown executor task | Reject resume; explicitly submit a new Task with target; no goal-based executor rematch |
| Task already carrying an execution binding | Only the exact retained Session can continue; compatibility adoption cannot replace it |

Adoption is limited to paused/waiting-user historical generic tasks with a structured desktop route and no existing target, binding or version. It records `desktop_compatibility_selected` and immutable `desktopCompatibility` provenance before Session acquisition, parks the Task as paused with recovery required, and preserves its uncertain-action evidence. Continue must reobserve/reconcile; old approvals cannot replay. It opens no Session, calls no model, and grants no input. Missing validators, unknown targets and mismatched/unproven historical identities explicitly reject. Migration of an old checkpoint is allowed only for this recorded compatibility path; conflicting checkpoint identities reject before continuation.

Startup parking recognizes structured Task target, VM/window provenance or Windows task contract, without parsing goals. Old ambiguous text-only Tasks remain untouched and cannot continue through the generic compatibility gate.

## Validation and review boundary

Required checks: `npm run check`, `npm run test:offline`, `npm run test:python`; backend API changes also receive the existing `npm run test:browser` suite against local synthetic fixtures. New Task-binding tests cover all four identity dimensions, exact acquisition order, stale/missing Sessions, unsupported executors, immutable persistence/checkpoints, late-open cleanup, historical adoption and specialized-executor bypass rejection. Hyper-V protocol tests exercise the actual compatibility adapter with a local fake Worker, including backend replacement, lifecycle ownership and competing-session completion fencing. Existing workflow/recovery tests retain their reobserve/reconcile and original-version assertions using the same binding; process-loss rejection is tested separately.

The existing `workflow-library.test.ts` report download fails with `download.saveAs: canceled` on this Windows host. The identical failure was reproduced on the unchanged base tree `93a07e283de3321b2ab1fe9861d25328711ba366` (the trees of merge `75cd092` and its P4 head `65b2b4d` are identical). This failure remains visible; no test is skipped or weakened, and no unrelated UI/download fix is included. Final-head command results belong in the PR review record.

No real desktop/VM/application/model experiment, UI implementation or new Provider executor route is included. Independent review of `a923b358b7eda9244ce556812ea5ca548be46db0` concluded **CHANGES REQUIRED** for Workflow goal routing and Browser target requirements. The Workflow corrections require a narrow re-review of the new exact head. No merge or P5-B continuation is authorized by this checkpoint. Historical A5 `safety FAIL`, Windows `PAUSED`, and overall `INCOMPLETE` remain unchanged.
