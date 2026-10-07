# P6-A — Target binding and scoped execution admission

Issue #12; branch `codex/p6-target-binding-admission`; base `117e6b081f3e45894b83a089eea4e2d0c1e29473`.

A selected desktop identifies an environment, not executable application support. P6-A adds a reusable runtime admission boundary that proves the specific backend-bound target and operation before dispatch. P6-B connects accepted Local Workspace/NetEase finite scenarios to Tasks; P6-C adds target/scenario selection to the UI.

## Contracts and execution

`src/contracts/desktop-execution.ts` defines `TargetBinding`, target status, executor requirements and a composition-owned `DesktopExecutionBackend<Action, Result>` port. Provider remains a discovery/Session lifecycle interface. No application operation, native handle, endpoint or grant is added to Provider or the target binding. The target extends the existing opaque Session/target identity with backend-established application, exact version and target role. `TaskDesktopTarget` and the durable P5 execution binding retain their existing meanings and schemas; the new binding is runtime-owned and cannot restore authority from a checkpoint.

`DesktopExecutionAdmission` copies and freezes the issued public binding, pins the Provider and full Session identity, and retains only targets explicitly bound through its trusted backend port. Unknown targets, another Session/resource/instance, changed application/version/role and mismatched observations fail closed. Binding does not acquire input or prove action support. There is no automatic replacement Session, target rebind or mechanism fallback.

Each execution snapshots the caller's action, observation and authority before awaiting any port. The trusted executor derives the action label, mechanism and complete capability requirements from the operation; the caller has no requirement, role or mechanism override. Provider, Session and Target evidence and Session/Target readiness are read anew. Every required capability must pass all three layers using the existing conservative conjunction: missing, unsupported, not-proven, forbidden, conflicting declarations, absent evidence and scope mismatch reject. All seven scope dimensions are enforced. Readiness cannot promote evidence. Invalid or sparse declaration/evidence/scope arrays cannot manufacture proof.

Host verifies exact observation identity and current Agent authority before and after asynchronous reads. Concurrent execution on one gate rejects. Invalidation prevents pending admission from reaching dispatch and closes subsequent binding/execution. It invalidates the Host gate only: resource revocation, runtime drain and Session cleanup remain the lifecycle owner's responsibility.

The backend port must independently recheck current instance/Session/target identity, observation freshness and consumption, Agent authority, actual executor requirements, all capability layers and readiness immediately at effect time, including queued work. Host admission never produces a reusable authorization token. Native adapters must implement these fences before P6-B can compose them into Tasks. A lost or uncertain dispatch must still follow existing observe/reconcile rules, budgets and risk gates.

## Materialization boundary

The Fake backend and runtime compose the shared gate through `executionBackend()` and `scopedExecution()`. The P6 Fake dispatch independently validates support and input ownership and consumes its observation once. Original P1 synchronous fixture entrypoints remain for existing contract tests. This synthetic path performs no OS input or application launch and is not production Task admission.

Production Task routing and the Host/Guest protocol are unchanged. Hyper-V retains its explicitly documented compatibility executor; its unproven generic input declarations are not upgraded. Physical still rejects generic Tasks before planning despite an allowed policy. Local Workspace still exposes its existing finite P4 runtime and does not gain arbitrary Task/Workflow support. UI selection and accepted scenario integration remain P6-C and P6-B respectively.

One inherited baseline type error in `tests/physical-task-routing.test.ts` is repaired by annotating the fixture argument as `PhysicalInputPolicy`, preserving its readonly executor list. No assertion or execution permission changes.

## Validation

New execution tests cover all environment families, every denied parent layer, application/action scope differences, evidence, forbidden fallback requirements, target/observation forgery, instance replacement, single-use observations, Human versus Agent grants, lease expiry, caller mutation, concurrent execution, asynchronous revocation and backend changes after Host admission. Existing P1 capability tests also cover sparse evidence and malformed scope arrays.

Final source validation on this working diff against the base above:

| Check | Result |
| --- | --- |
| `npm run check` | PASS |
| `npm run test:offline` | 566/566 PASS; zero skipped |
| `npm run test:python` | All 13 contract files PASS |
| P6 execution + P1 capability/instance + Physical routing suites | 48/48 PASS, including 26 new P6 execution tests |
| `git diff --check` | PASS |
| Browser / live Windows gates | Not run; no UI, HTTP or native protocol change |

Logs remain private and ignored: `.artifacts-p6-offline-final.log`, `.artifacts-p6-python-final.log` and `.artifacts-p6-targeted.log`. The first sandboxed Python run failed because Anaconda's `_ctypes` DLL could not initialize. Both subsequent runs outside the sandbox, including the final source run, passed without a code or dependency workaround. The final offline run follows the last TypeScript change; the earlier 565-test run is not reported as the final result.

No real model, VM, desktop application, third-party site or Windows experiment is part of this checkpoint. Historical P5-B `540/540` and Browser results are not reused as P6 results; inherited Browser failure remains documented in P5-B. This is an author-validated local implementation, not an independent review acceptance or a claim of production Task support.
