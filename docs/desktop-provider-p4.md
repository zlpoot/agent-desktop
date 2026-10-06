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

The Provider is unavailable unless an application is explicitly configured and the host is Windows (unless a backend factory is explicitly injected for a harness). Opening a Session starts the D0 worker; importing or discovering the Provider does not start a desktop process. NetEase requires an explicit executable path and exactly the accepted song/artist (`我怀念的` / `孙燕姿`); it is rejected unless the installed version is `3.1.40.205461`. Provider, Session, and Target scopes are checked before execution. The Target narrows targeted input to the finite validated scenario and semantic editing to the search editor.

## Ownership and identity

The Python bridge is a local JSON-lines child process. Its only runtime methods are `start`, `state`, `set_owner`, `frame`, `act`, `ping`, `stop`, and `close`; it does not expose a generic action or command API. Viewer takeover and heartbeat events return to the Host and use the same `DesktopInputArbiter` instance injected into Physical Desktop. A grant is usable only after backend owner/epoch acknowledgment. Handoff drains the old D0 epoch before activating the successor; failed drain or activation leaves the resource blocked.

The immutable Provider Session binds a bridge nonce, live Worker process, owned Job, hidden desktop handle/name, D0 run, Windows Session, and opaque target identity. Host status and backend requests reject changed instances; once stale, restoration of the original identity cannot revive old handles or frames. A new Session must acquire authority, bind its Target, observe, and reconcile before acting. Observations contain only the D0 frame and allowlisted NetEase UIA roles; the Viewer bearer token is available only through a trusted human-owned integration and is never included in an observation.

`observe()` requires explicit binding and verifies PNG chunks, CRCs, decompressed scanlines, dimensions, SHA-256, size, and increasing frame sequence before saving it under the private artifact directory. Backend frame age and Host observation age are bounded to two seconds. `runValidatedScenario()` can run only the finite D0 scenario, only once, and only after a fresh observation with current Agent authority. Identity mismatch, revoked authority, or backend error invalidates the Session. Stop confirms owned Job and desktop cleanup; failure remains unconfirmed and does not release the shared input resource. Provider shutdown waits for pending startup and closes late Sessions.

Managed Viewer input checks both backend identity and shared Human authority. Its Run/Act routes are disabled in Provider mode, so it cannot create an independent backend or bypass the Agent runtime. Late activation/drain acknowledgments cannot clear a terminal resource block or restore a closed Session. The original standalone D0 Viewer behavior is retained outside Provider mode.

## Validation and remaining gates

Checkpoint validation commands are `npm run check`, `npm run test:offline`, `npm run test:python`, targeted Provider/instance/resource regressions, `python tests/test_local_workspace_provider.py -v`, `npm run test:local-workspace`, and `git diff --check`. The P4 PR binds their results to its exact source head. Python tests use synthetic state and a local HTTP harness; they do not start native desktops. Existing accepted D0 spike evidence is reused.

No real Windows session, installed application, Viewer session, VM, or model experiment was run for this checkpoint. Independent review and Issue #6 acceptance remain outstanding. If formal-adapter live evidence is required, the minimum proposed gate is one configured Session: bind/observe, the finite NetEase scenario, Human takeover/resume with fresh observation, and disconnect/budget cleanup while confirming that parallel Default Desktop use remains unaffected. This is a proposal, not a completed verification. P5/UI/Task routing and Issues #6/#7 scope are unchanged. Historical A5 `safety FAIL`, Windows `PAUSED`, and overall `INCOMPLETE` remain unchanged.
