# P4 Local Workspace Provider

**Status: implementation checkpoint ready; tests pass; independent review not started.** This adapter maps the accepted D0 Hidden Desktop spike into the Provider contract. It does not broaden D0 evidence or claim support for arbitrary Windows applications.

## Scope

| Capability | P4 declaration | Scope |
|---|---|---|
| Pixel observation | supported | D0-owned target window and accepted fixture / NetEase path |
| Targeted window input | supported | Existing D0 owned-HWND worker path |
| Accessibility / semantic input | supported for NetEase; otherwise not-proven | NetEase 3.1.40.205461 and the recorded UIA/ValuePattern subset |
| Human takeover, resume, lease protection | supported | Shared `ResourceInputControl`, D0 owner epoch and local Viewer lease |
| Separate desktop / shared user session | supported | Same Windows OS and user session, dedicated D0 desktop |
| Separate OS | unsupported | D0 shares the host OS and user session |
| Raw isolated input | not-proven | No raw-input adapter was added |
| Global input | forbidden | No system input, cursor positioning, or default-desktop fallback |
| Other applications | not-proven | Provider can only be configured for the fixture or the exact validated NetEase version |

The Provider is unavailable unless an application is explicitly configured and the host is Windows (unless a backend factory is explicitly injected for a harness). Opening a Session starts the D0 worker; importing or discovering the Provider does not start a desktop process. NetEase requires an explicit executable path, song, and artist and is rejected unless the installed version matches the accepted D0 version.

## Ownership and identity

The Python bridge is a local JSON-lines child process. Its only runtime methods are `start`, `state`, `set_owner`, `frame`, `act`, `ping`, `stop`, and `close`; it does not expose a generic action or command API. Viewer takeover and heartbeat events return to the Host and use the same `DesktopInputArbiter` instance injected into Physical Desktop. A grant is usable only after backend owner/epoch acknowledgment. Handoff drains the old D0 epoch before activating the successor; failed drain or activation leaves the resource blocked.

The immutable Provider Session binds the D0 run, hidden desktop, Windows Session, and opaque target identity. Status rechecks the run, target, desktop, owner epoch, readiness, and validated NetEase version. Any drift makes the Session stale and initiates cleanup. Observations contain only the D0 frame and allowlisted NetEase UIA roles; the Viewer bearer token is available only through a trusted human-owned integration and is never included in an observation.

`observe()` verifies the PNG signature, dimensions, SHA-256, and size before saving it under the private artifact directory. `runValidatedScenario()` can run only the finite D0 scenario, only once, and only after a fresh observation with current Agent authority. A stale observation, identity mismatch, revoked authority, or backend error invalidates the Session. Stop confirms owned Job and desktop cleanup; failure remains unconfirmed and does not release the shared input resource.

## Validation and remaining gates

Validation passed: P4 targeted tests 7/7; D0 Python regression 51/51; D0 Viewer browser regression 1/1; `npm run test` twice, 493/493 each run; `npm run test:python`, all 12 Python contract files; `npm run check`; Python bytecode compilation for the bridge and D0 host; and `git diff --check`. The Viewer browser test needed an elevated retry after Chromium exited in the sandbox and Playwright's cleanup was denied. No real Windows session, installed application, Viewer session, or VM experiment was run for P4. Independent review has not started; the P4 acceptance gates in GitHub Issue #6 remain outstanding. Historical A5 `safety FAIL`, Windows `PAUSED`, and overall `INCOMPLETE` remain unchanged.
