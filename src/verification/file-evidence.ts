import type {VerificationContract,VerificationInput} from './contracts.js';
import {win32} from 'node:path';

/** Guest collector output. A file path is resolved and checked against Guest Desktop. */
export interface DesktopFileSnapshot {
  path:string;root:string;capturedAt:number;exists:boolean;complete:boolean;
  kind?:'file'|'non_file';size?:number;mtimeMs?:number;sha256?:string;text?:string;
}

export interface DesktopFileExpectation {kind:'desktop_file';path:string;contentEquals?:string;sha256?:string}

/** A completed action's original Guest evidence; never inferred from a window title. */
export interface VerifiedDesktopFile {
  taskId:string;step:number;expected:DesktopFileExpectation;
  before:DesktopFileSnapshot;after:DesktopFileSnapshot;
}

/** Re-read at task completion so a later deletion or modification cannot reuse an old pass. */
export function currentFileEvidence(proof:VerifiedDesktopFile,current:DesktopFileSnapshot|undefined):
  {current?:DesktopFileSnapshot;reason?:string} {
  if(!current)return {reason:'missing_current_file_capture'};
  if(!current.complete)return {reason:'current_file_capture_incomplete'};
  // Windows/NTFS is case-insensitive: the Guest echoes the requested path casing
  // for an absent file but returns the canonical on-disk casing once it exists.
  if(current.path.toLowerCase()!==proof.after.path.toLowerCase()||
    current.root.toLowerCase()!==proof.after.root.toLowerCase()||
    win32.resolve(current.root,proof.expected.path).toLowerCase()!==current.path.toLowerCase())
    return {reason:'current_file_identity_changed'};
  if(!Number.isFinite(current.capturedAt)||current.capturedAt<proof.after.capturedAt)
    return {reason:'current_file_capture_order_unconfirmed'};
  if(current.exists&&(current.kind!=='file'||!Number.isFinite(current.size)||
      !Number.isFinite(current.mtimeMs)||!/^[0-9a-f]{64}$/i.test(current.sha256??'')))
    return {reason:'current_file_metadata_incomplete'};
  if(current.exists&&proof.expected.contentEquals!==undefined&&current.text===undefined)
    return {reason:'current_file_text_unavailable'};
  return {current};
}

/** File presence/content is read independently of the desktop screenshot. */
export function fileEvidenceInput(taskId:string,step:number,expected:DesktopFileExpectation,
  before:DesktopFileSnapshot|undefined,after:DesktopFileSnapshot|undefined,
  effect:'none'|'dispatched'|'uncertain'|undefined):{input?:VerificationInput;reason?:string} {
  if(effect!=='dispatched')return {reason:'action_dispatch_not_confirmed'};
  if(!before||!after)return {reason:'missing_file_capture_boundary'};
  if(!before.path||!after.path||!before.root||!after.root)
    return {reason:'file_identity_changed'};
  // Windows/NTFS is case-insensitive: an absent target echoes the requested path
  // casing, while once created the Guest reports its canonical on-disk casing, so
  // before/after legitimately differ only in case across the creation boundary.
  if(before.path.toLowerCase()!==after.path.toLowerCase()||
    before.root.toLowerCase()!==after.root.toLowerCase())
    return {reason:'file_identity_changed'};
  if(win32.resolve(after.root,expected.path).toLowerCase()!==after.path.toLowerCase())
    return {reason:'file_does_not_match_declared_path'};
  if(!Number.isFinite(before.capturedAt)||!Number.isFinite(after.capturedAt)||
    before.capturedAt>=after.capturedAt||after.capturedAt-before.capturedAt>60_000)
    return {reason:'file_capture_order_unconfirmed'};
  if(!before.complete||!after.complete)return {reason:'file_capture_incomplete'};
  if(before.exists&&before.kind!=='file'||after.exists&&after.kind!=='file')
    return {reason:'desktop_path_not_regular_file'};
  if([before,after].some(snapshot=>snapshot.exists&&
    (!Number.isFinite(snapshot.mtimeMs)||!Number.isFinite(snapshot.size)||
      !/^[0-9a-f]{64}$/i.test(snapshot.sha256??''))))
    return {reason:'file_metadata_incomplete'};
  if(before.exists&&after.exists&&before.mtimeMs===after.mtimeMs&&before.sha256===after.sha256)
    return {reason:'file_unchanged_since_baseline'};
  if(expected.contentEquals!==undefined&&after.exists&&after.text===undefined)
    return {reason:'file_text_unavailable'};
  if(expected.sha256!==undefined&&after.exists&&after.sha256===undefined)
    return {reason:'file_hash_unavailable'};
  const requirement='declared-desktop-file-result';
  const object=`desktop-file:${after.path}`;
  const fields:[string,string|boolean][]=[['exists',true]];
  if(expected.contentEquals!==undefined)fields.push(['text',expected.contentEquals]);
  if(expected.sha256!==undefined)fields.push(['sha256',expected.sha256.toLowerCase()]);
  const contract:VerificationContract={id:`${taskId}:${step}:desktop-file`,scope:'action',
    requirements:[requirement],criteria:fields.map(([field,value])=>({id:`file-${field}`,requirement,
      object,field,sources:['file'],predicate:{op:'equals',expected:value}}))};
  const now=after.capturedAt;
  return {input:{contract:structuredClone(contract),specification:structuredClone(contract),
    session:taskId,now,notBefore:after.capturedAt,
    evidence:fields.filter(([field])=>field==='exists'||after.exists).map(([field])=>({
      id:`file:${step}:${field}:${now}`,session:taskId,object,field,
      source:'file',value:field==='exists'?after.exists:field==='text'?after.text!:after.sha256!,
      capturedAt:now,complete:true})),execution:'dispatched'}};
}
