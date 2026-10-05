/** Transport/identity/session failure; distinct from an application operation failure. */
export class WorkerConnectionError extends Error {
  readonly code = "WORKER_CONNECTION_UNAVAILABLE";
}

/** Application preparation failed while the transport remains reachable. */
export class GuestAppSetupError extends Error {}

/** The bound window disappeared while the Worker transport is still reachable. */
export class TargetWindowLostError extends Error {
  readonly code = "TARGET_WINDOW_LOST";
}
