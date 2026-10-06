# P4 Local Workspace Provider

**Status: implementation checkpoint for independent review; P4 is not ACCEPTED/CLOSED.** This adapter maps the accepted D0 Hidden Desktop spike into the Provider contract. It does not broaden D0 evidence or claim support for arbitrary Windows applications.

## Scope

| Capability | P4 declaration | Scope |
|---|---|---|
| Pixel observation | supported | D0-owned target window and accepted fixture / NetEase path |
| Targeted window input | supported | Existing D0 owned-HWND finite scenario / Viewer click path |
| Accessibility / semantic input | supported for NetEase; otherwise not-proven | NetEase 3.1.40.205461 and the recorded UIA/ValuePattern subset |
| Human takeover, resume, lease protection | supported | Shared `ResourceInputControl`, D0 owner epoch and local Viewer lease |
| Separate desktop / shared user session | supported | Same Windows OS and user session, dedicated D0 desktop |
| Separate OS | unsupported | D0 shares the host OS and user session |
| Raw isolated input | not-proven | No raw-input adapter was added |
| Global input | forbidden | No system input, cursor positioning, or default-desktop fallback |
| Other applications | not-proven | Provider can only be configured for the fixture or the exact validated NetEase version |

The Provider is unavailable unless an application is explicitly configured and the host is Windows (unless a backend factory is explicitly injected for a harness). Opening a Session starts the D0 worker; importing or discovering the Provider does not start a desktop process. NetEase requires an explicit executable path and exactly the accepted song/artist (`我怀念的` / `孙燕姿`); it is rejected unless the installed version is `3.1.40.205461`. Provider, Session, and Target scopes are checked before execution. Target declarations retain separate action/role/mechanism scopes: the finite scenario, fixture editor/button click and editor character messages, NetEase playback-button messages, and NetEase search-editor UIA selection/ValuePattern editing. They do not admit arbitrary controls.

## Ownership and identity

The Python bridge is a local JSON-lines child process. Its only runtime methods are `start`, `state`, `activate_grant`, `revoke_grant`, `frame`, `act`, `ping`, `stop`, and `close`; it does not expose a generic action or command API. Viewer takeover and heartbeat events return to the Host and use the same `DesktopInputArbiter` instance injected into Physical Desktop. Each backend grant pins the complete Host authority (Session/instance/resource, epoch, opaque grantId, owner/client). Activation and neutral revoke each fence a D0 epoch, including Agent→Agent and Human→Human. A grant is usable only after backend owner/epoch acknowledgment. Handoff drains the old D0 epoch before activating the successor; failed drain or activation leaves the resource blocked.

The immutable Provider Session binds a bridge nonce, live Worker process, owned Job, hidden desktop handle/name, D0 run, Windows Session, and opaque target identity. Host status and backend requests reject changed instances; once stale, restoration of the original identity cannot revive old handles or frames. A new Session must acquire authority, bind its Target, observe, and reconcile before acting. Observations contain only the D0 frame and allowlisted NetEase UIA roles; the Viewer bearer token is available only through a trusted human-owned integration and is never included in an observation.

`observe()` requires explicit binding and verifies PNG chunks, CRCs, decompressed scanlines, dimensions, SHA-256, size, and increasing frame sequence before saving it under the private artifact directory. An opaque, single-use backend observation token pins instance, run, target, grant, D0 epoch, frame sequence and capture-derived Python deadline. Host starts a conservative remaining-lifetime deadline before the frame RPC and checks again immediately before Act; confirmation and artifact work cannot renew it. Backend checks the token and current frame independently, consumes it, and passes the original deadline to the native queue. A revoked, unaccepted scenario command is never requeued with a fresh deadline; an already accepted bounded intent can resume without replay. `runValidatedScenario()` can run only the finite D0 scenario, only once, and only after a fresh observation with current Agent authority. Identity mismatch, revoked authority, or backend error invalidates the Session. Revoke, native Stop, and transport Close are all attempted independently. Python Close also attempts server shutdown, socket close, thread join and Controller close after any earlier failure. Cleanup errors remain aggregated and permanently block the shared input resource; successful bridge closure cannot clear native cleanup failure. Provider shutdown waits for pending startup and closes late Sessions.

Managed Viewer input checks backend identity, full Human authority, native-worker-normalized control context, and Provider/Session/Target capability and readiness admission. The worker revalidates the same context at effect time. Browser-provided action/role labels are rejected. `GET /status` and `GET /frame` are read-only and remain usable after Resume; `POST /heartbeat` renews only the current Human control token/grant. UI readiness/progress fields survive transfer, and callback errors return deterministic HTTP responses. Control tokens are omitted from rendered status and evidence. Its Run/Act routes are disabled in Provider mode, so it cannot create an independent backend or bypass the Agent runtime. Late activation/drain acknowledgments cannot clear a terminal resource block or restore a closed Session. The original standalone D0 Viewer behavior is retained outside Provider mode.

## Validation and remaining gates

Checkpoint validation commands are `npm run check`, `npm run test:offline`, `npm run test:python`, targeted Provider/instance/resource regressions, `python tests/test_local_workspace_provider.py -v`, `npm run test:local-workspace`, and `git diff --check`. The P4 PR binds their results to its exact source head. Python tests use synthetic state and a local HTTP harness; they do not start native desktops. Existing accepted D0 spike evidence is reused.

No real Windows session, installed application, Viewer session, VM, or model experiment was run for this checkpoint. Independent re-review and Issue #6 acceptance remain outstanding. **MINIMAL LIVE GATE REQUIRED**, after same-head independent re-review PASS. P5/UI/Task routing and Issues #6/#7 scope are unchanged. Historical A5 `safety FAIL`, Windows `PAUSED`, and overall `INCOMPLETE` remain unchanged.

## Prepared minimal live gate — NOT RUN

`testbench/p4/local-workspace-live.ts` prepares the configured Provider path, rather than the standalone D0 verifier. It requires explicit `--live`, Windows, a clean reviewed tree, and `P4_REVIEW_PASS_HEAD` equal to current HEAD. Only set this value after independent re-review PASS and subsequent explicit authorization to run the live gate.

```powershell
# Preparation only; do not execute during the blocker-fix checkpoint.
$env:NETEASE_APP_PATH = '<explicit installed cloudmusic.exe path>'
$env:P4_REVIEW_PASS_HEAD = '<same-head independent re-review PASS SHA>'
node --import tsx testbench/p4/local-workspace-live.ts --live
```

The one Session binds/observes the exact accepted NetEase target, executes the finite scenario once, and waits for completion. While Agent authority and its existing heartbeat remain active, the trusted gate backend provides the private authenticated Viewer URL. Type `READY` only after opening the Viewer and confirming it is polling; do not use its controls before the gate transfers to Human. The harness rechecks the original Agent authority before transfer, then requires Viewer Resume and a fresh observe/reconcile. Keep the Viewer polling throughout takeover: the original 3-second lease and 60-second D0 duration budget still apply, including the bootstrap wait. This gate-only bootstrap does not change the production Provider's Human-authority requirement for `viewerUrl()`. In parallel, manually exercise Default Desktop and confirm no focus steal, no mouse jump, and no cross-input. The harness always attempts Session/Provider cleanup and writes private evidence beneath `.artifacts/p4-live/<exact-head>/<timestamp>/gate.json`; bearer/control tokens are never written there. Failure or unconfirmed cleanup yields FAIL. No new app, input mechanism, model, or Task binding is introduced.
