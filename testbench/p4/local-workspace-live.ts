/** Prepared gate only. Requires same-head re-review PASS and explicit live invocation. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { DesktopSession, DesktopSessionIdentity } from "../../src/contracts/desktop-environment.js";
import type { InputAuthority, InputClient } from "../../src/contracts/desktop-input-control.js";
import { LocalWorkspaceDesktopProvider, createD0WorkspaceBackendFactory,
  type LocalWorkspaceBackend } from "../../src/desktop-provider/local-workspace-provider.js";
import { ResourceInputControl } from "../../src/desktop-provider/resource-input-control.js";

const root = process.cwd();
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert(process.argv.includes("--live"), "Explicit --live required; this file does not run in offline suites");
assert.equal(process.platform, "win32");
assert.equal(process.env.P4_REVIEW_PASS_HEAD, head, "Set only after independent re-review PASS on this exact head");
assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "", "Clean reviewed tree required");
assert(process.env.NETEASE_APP_PATH, "Explicit validated executable path required");

class GateInput extends ResourceInputControl {
  current?: InputAuthority;
  override async acquire(binding: DesktopSessionIdentity, owner: InputClient) {
    return this.current = await super.acquire(binding, owner);
  }
  override async transfer(authority: InputAuthority, owner: InputClient) {
    return this.current = await super.transfer(authority, owner);
  }
}
const input = new GateInput();
const directory = resolve(root, ".artifacts", "p4-live", head, new Date().toISOString().replace(/[:.]/g, "-"));
const factory = createD0WorkspaceBackendFactory(root, process.env.PYTHON_PATH);
let backend: LocalWorkspaceBackend | undefined, session: DesktopSession | undefined;
const provider = new LocalWorkspaceDesktopProvider(input, { app: "netease", path: process.env.NETEASE_APP_PATH,
  song: "我怀念的", artist: "孙燕姿" }, directory, root, path => backend = factory(path));
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const evidence: Record<string, unknown> = { head, gate: "configured-provider-netease", result: "INCOMPLETE" };
const failures: unknown[] = [];
try {
  session = await provider.open("local-workspace:netease");
  const agent = await input.acquire(session, { kind: "agent", clientId: "p4-live-agent" });
  const runtime = provider.connectRuntime(session, agent, directory);
  const target = await runtime.bind();
  const first = await runtime.observe();
  await runtime.runValidatedScenario();
  const deadline = performance.now() + 18000;
  while (true) {
    const { state } = await backend!.state();
    assert.equal(state.status, "ready");
    if (state.input === "PASS") break;
    assert(performance.now() < deadline, "Bounded scenario did not complete");
    await delay(200);
  }
  const human = await input.transfer(agent, { kind: "human", clientId: "p4-live-viewer" });
  // Private terminal only: bearer URL is never serialized into evidence.
  console.log("Open this private Viewer immediately, keep it polling, perform only the proven controls, then Resume:");
  console.log(provider.viewerUrl(session, human));
  await terminal.question("After Viewer Resume, press Enter (the existing 60-second D0 budget still applies). ");
  const resumed = input.current!;
  assert.equal(resumed.owner.kind, "agent"); input.assertAuthority(session, resumed);
  const reconciled = provider.connectRuntime(session, resumed, directory);
  await reconciled.bind();
  const after = await reconciled.observe();
  const { state } = await backend!.state();
  assert.equal(state.input, "PASS"); assert.equal(state.agent_progress, 4);
  assert(state.control_ready && state.input_ready && state.resume_observation);
  evidence.observations = { targetId: target.targetId, before: first.capture?.sequence, after: after.capture?.sequence };
  evidence.reconcile = { input: state.input, progress: state.agent_progress, resume: state.resume_observation };
  const safety = await terminal.question("Confirm parallel Default Desktop use: no focus steal, no mouse jump, no cross-input. Type PASS only if all three held. ");
  assert.equal(safety.trim(), "PASS", "Manual Default Desktop safety gate failed or unconfirmed");
  evidence.defaultDesktop = { noFocusSteal: true, noMouseJump: true, noCrossInput: true, source: "manual" };
} catch (error) { failures.push(error); }
finally {
  try { await session?.close(); } catch (error) { failures.push(error); }
  try { await provider.close(); } catch (error) { failures.push(error); }
  terminal.close();
  evidence.cleanup = failures.length ? "UNCONFIRMED_OR_GATE_FAILED" : "PASS";
  evidence.result = failures.length ? "FAIL" : "PASS";
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "gate.json"), JSON.stringify(evidence, null, 2));
}
console.log(`Gate ${evidence.result}; private evidence: ${directory}`);
if (failures.length) throw new AggregateError(failures, "P4 minimal live gate incomplete");
