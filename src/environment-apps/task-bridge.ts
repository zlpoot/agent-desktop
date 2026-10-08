import type { DesktopSession } from '../contracts/desktop-environment.js';
import type { EnvironmentAppRegistry } from '../contracts/environment-apps.js';
import type { WorkerClient } from '../contracts/worker-client.js';
import type { TaskAppDispatchBinding } from '../app/task-desktop-sessions.js';
import { assertAppAdmission } from './admission-gate.js';
import { ControlledAppLauncher, launchDefinition } from './launcher.js';
import { sameAppScope } from './validation.js';

/** Structural bridge only. Receipt provenance is not native target/authority proof.
 * No Worker, input lease, focus/restore, launch or native RPC is constructed here.
 * Deliberately has no appTrustFence: native resolution + revoke/effect ACK are absent. */
export class UnavailableAppTaskBridge {
  constructor(private readonly issuer: ControlledAppLauncher, private readonly registry: EnvironmentAppRegistry) {
    if (!sameAppScope(issuer.scope, registry.scope)) throw new Error('app-task-issuer-scope-mismatch');
  }
  async connectAppRuntime(session: DesktopSession, _artifactDir: string, binding: TaskAppDispatchBinding): Promise<WorkerClient> {
    const snapshot = structuredClone({ profile: binding.profile, target: binding.target });
    const assertTrust = binding.assertCurrentTrust;
    const sessionKey = () => JSON.stringify([session.providerId, session.environmentId, session.sessionId,
      session.instanceId, session.inputResourceId]);
    const originalSession = sessionKey();
    const current = () => {
      assertTrust(); assertAppAdmission(this.registry, snapshot.profile.appBindingId);
      const profile = this.registry.get(snapshot.profile.appBindingId);
      if (!profile || profile.validity !== 'current' || profile.trust !== 'verified' || profile.availability !== 'available' ||
          !sameAppScope(profile.scope, snapshot.profile.scope) || !sameAppScope(profile.scope, snapshot.target.scope) ||
          profile.profileRevision !== snapshot.profile.profileRevision || profile.profileDigest !== snapshot.profile.profileDigest ||
          profile.installationId !== snapshot.profile.installationId || JSON.stringify(profile.identity) !== JSON.stringify(snapshot.profile.identity) ||
          launchDefinition(profile.launchSpec) !== launchDefinition(snapshot.profile.launchSpec)) throw new Error('app-task-profile-no-longer-current');
      if (sessionKey() !== originalSession || session.providerId !== profile.scope.providerId || session.environmentId !== profile.scope.environmentId) {
        throw new Error('app-task-provider-session-mismatch');
      }
    };
    current();
    const handoff = await this.issuer.handoffIssuedTarget(this.registry, snapshot.profile, snapshot.target, session);
    current(); // Host checks after await reject races; they do NOT establish a producer fence.
    this.issuer.assertIssuedTargetHandoff(handoff, session);
    // P7 reservation IDs and Provider Session IDs cannot be equated. Existing D0
    // starts its own target and has no same-issuer resolver or Registry effect RPC.
    throw new Error('app-task-native-issuer-resolution-and-revoke-fence-unavailable');
  }
}
