---
name: lab-tasks
description: Run registered Agent Desktop labs tasks through the labs MCP tools, inspect their execution and verification results, and release the session. Use for this lab's synthetic task experiments; real desktop and model execution are unavailable in v1.
---

Use `capabilities_list` and `capability_describe` to discover the configured task and its inputs. Prefer the registered workflow for a complete task; use sub-capabilities when the user requests a particular stage. Report `mode=synthetic` and the stated verification scope.

Call `task_start` with the registered `capabilityId`, business `inputs`, and a request ID chosen once for this user action. Keep the returned `jobId`. The receipt means accepted, not completed. Query `task_status` until execution finishes; space repeated queries rather than busy polling.

If the start response is lost, repeat the same request ID and identical inputs on the same connection. A new request ID may repeat effects. Deduplication and jobs last only for this process; after a connection restart the previous outcome is unknown, so do not silently resubmit.

Treat execution and verification separately. `verification.status=manual-required` is not automatic acceptance. `effectStatus=unknown`, failed verification, lease expiry, stale targets, or recovery-required stops the workflow. Do not retry inputs, relearn, relax matching, or start a replacement session to conceal failure. Report the job's error and known scope.

Use `observation_get` while idle if current state is useful. It returns synthetic state, not a real screenshot or proof of real application behavior. Finish with `session_close` and check `cleanup.closed`. A busy close does not cancel the task: continue querying its original job, then close. Preserve failed results in the report.

For example, describe `synthetic.form.submit`, then submit `inputs={"query":"Synthetic example"}`. Its dispatch requires manual acceptance even when execution is `done`. A request to access real apps or models requires a separately implemented and authorized backend; this version has no such mode.
