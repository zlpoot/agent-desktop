import type { EnvironmentAppScope } from './environment-apps.js';
import type { TaskDesktopTarget } from './task-desktop.js';

/** Task setup data only: launch receipts and input authority are never persisted here. */
export interface TaskAppInteraction {
  taskId: string;
  interactionId: string;
  appName: string;
  desktopTarget: TaskDesktopTarget;
  scope?: EnvironmentAppScope;
  state: 'reusing' | 'discovering' | 'candidates' | 'not_found' | 'unavailable' | 'rejected' | 'launching' | 'ready' | 'cancelled' | 'new_task_required';
  candidates: Array<{ candidateId: string; candidateRevision: number; displayName: string;
    path: string; args: readonly string[]; workingDirectory?: string; sources: readonly string[]; version?: string; publisher?: string; limitation?: string }>;
  appBindingId?: string;
  profileRevision?: number;
  profileDigest?: string;
  reason?: string;
}
export interface TaskAppRequest {
  interactionId: string;
  desktopTarget: TaskDesktopTarget;
  action: 'confirm' | 'reject' | 'rescan' | 'path' | 'cancel';
  candidateId?: string;
  candidateRevision?: number;
  path?: string;
}
