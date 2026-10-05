import type {
  CapabilityContext, CapabilityDeclaration, CapabilityState, DesktopCapabilities,
  DesktopCapability, DesktopEnvironmentKind, DesktopReadiness,
} from "../../src/contracts/desktop-environment.js";
import { FakeDesktopBackend, FakeDesktopProvider, FakeDesktopRuntime,
  type FakeBackendDefinition, type FakeActionRequest } from "../../src/desktop-provider/fake-provider.js";
import { FakeInputControl } from "../../src/desktop-provider/fake-input-control.js";

export const semantic: DesktopCapability = "input.semantic";
export const context: CapabilityContext = {
  providerId: "fake", environmentKind: "local-workspace", application: "fake-app",
  applicationVersion: "1.0", targetRole: "edit", action: "edit", mechanism: "fake-semantic",
};
export function declaration(state: CapabilityState = "supported",
  scope: CapabilityDeclaration["scope"] = { mechanism: ["fake-semantic"] }): CapabilityDeclaration {
  return { state, scope, evidence: [{ source: "synthetic:P1", description: "Synthetic contract evidence only" }] };
}
export function capabilities(state: CapabilityState = "supported"): DesktopCapabilities {
  return { [semantic]: [declaration(state)] };
}
export function ready(state: "ready" | "not-ready" | "unknown" = "ready"): DesktopReadiness {
  return { [semantic]: { state } };
}
export function definition(): FakeBackendDefinition {
  return { inputResourceId: "fake-input", capabilities: capabilities(), readiness: ready(),
    targets: {
      editor: { application: "fake-app", applicationVersion: "1.0", targetRole: "edit", readiness: ready(),
        capabilities: { [semantic]: [
          declaration("supported", { application: ["fake-app"], applicationVersion: ["1.0"],
            targetRole: ["edit"], action: ["edit"], mechanism: ["fake-semantic"] }),
          declaration("not-proven", { action: ["drag"], mechanism: ["fake-semantic"] }),
        ] } },
    }, operations: {
      edit: { mechanism: "fake-semantic", required: [semantic] },
      drag: { mechanism: "fake-semantic", required: [semantic] },
    } };
}
export async function fixture(options: { definition?: FakeBackendDefinition; providerCapabilities?: DesktopCapabilities;
  kind?: DesktopEnvironmentKind; input?: FakeInputControl } = {}) {
  const input = options.input ?? new FakeInputControl(() => 0);
  const backend = new FakeDesktopBackend(options.definition ?? definition(), input);
  const provider = new FakeDesktopProvider("fake", options.kind ?? "local-workspace",
    new Map([["fixture", backend]]), options.providerCapabilities ?? capabilities());
  const session = await provider.open("fixture");
  const runtime = new FakeDesktopRuntime(session, backend);
  const target = runtime.bind("editor");
  const observation = runtime.observe(target);
  const authority = await input.acquire(session, { kind: "agent", clientId: "task-1" });
  const request: FakeActionRequest = { observation, operationId: "edit", authority };
  return { input, backend, provider, session, runtime, target, observation, authority, request };
}
