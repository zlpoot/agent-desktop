import {win32} from 'node:path';

/**
 * A narrow, deterministic audit of file names explicitly present in the original task goal.
 * The goal is saved before planning, while declaredPaths come from the planned action/Workflow.
 * This audit does not claim to understand every natural-language requirement.
 */

/** Terminal basenames (lowercased) explicitly named after an output verb in the goal. */
export function explicitGoalFileNames(goal:string):string[] {
  const output=/保存|另存(?:为)?|写入|生成|导出|创建|下载|\b(?:save|write|create|export|download)\b/i.exec(goal);
  if(!output)return [];
  const clause=goal.slice(output.index+output[0].length);
  return [...new Set([...clause.matchAll(/(?<![\p{L}\p{N}_])[\p{L}\p{N}_-]+\.(?:txt|csv|pdf|docx?|xlsx?|png|jpe?g|json|md|html?|xml|zip)\b/giu)]
    .map(match=>match[0].toLowerCase()))];
}

/**
 * Exact body text the goal pins, if stated explicitly. Quoted/「」 bodies win;
 * otherwise a body introduced by 正文 + connector is read to the first sentence
 * separator. Ambiguous prose yields undefined so an expected value is never
 * invented (fails closed: existence/hash may still be checked, not exact text).
 */
export function explicitGoalFileBody(goal:string):string|undefined {
  const quoted=goal.match(/正文[^。；;\n]{0,16}?[「“"‘']([^」”"’']{1,4096})[」”"’']/);
  if(quoted)return quoted[1]!==''?quoted[1]:undefined;
  const bare=goal.match(/正文[^。；;\n]{0,16}?[是为：:]\s*([^\s。；;，,（()\n]+)/);
  return bare?bare[1]:undefined;
}

/**
 * Deterministically freeze the Desktop file results required by the original
 * goal, before any action. Values come solely from the user goal, never from the
 * model or an Oracle. Paths stay Desktop-relative basenames; the Guest resolves
 * and confines them under its Desktop root.
 */
export function desktopFileExpectationsFromGoal(goal:string):
import('./file-evidence.js').DesktopFileExpectation[] {
  const requiredNames=explicitGoalFileNames(goal);
  const body=requiredNames.length===1?explicitGoalFileBody(goal):undefined;
  return requiredNames.map(path=>{
    const expectation:import('./file-evidence.js').DesktopFileExpectation={kind:'desktop_file',path};
    if(body!==undefined&&body!=='')expectation.contentEquals=body;
    return expectation;
  });
}

export function auditGoalFileCoverage(goal:string,declaredPaths:readonly string[]):
  {covered:boolean;reason?:string;requiredNames:string[]} {
  const output=/保存|另存(?:为)?|写入|生成|导出|创建|下载|\b(?:save|write|create|export|download)\b/i.exec(goal);
  if(!output)return {covered:true,requiredNames:[]};
  const clause=goal.slice(output.index+output[0].length);
  const names=explicitGoalFileNames(goal);
  if(!names.length) {
    return /文件|文档|\b(?:file|document)\b/i.test(clause)&&!declaredPaths.length
      ?{covered:false,reason:'original_file_goal_has_no_file_contract',requiredNames:[]}
      :{covered:true,requiredNames:[]};
  }
  // The current Guest file collector is scoped to the Desktop. An explicit other
  // directory cannot be proved by a desktop-relative postcondition.
  if(/(?:[A-Za-z]:[\\/]|\\\\)/.test(clause))
    return {covered:false,reason:'original_file_path_outside_frozen_desktop_contract',requiredNames:names};
  const desktop=/桌面|\bdesktop\b/i.test(goal);
  const matching=(name:string)=>declaredPaths.some(path=>{
    if(win32.basename(path).toLowerCase()!==name)return false;
    if(!desktop)return true;
    const parent=win32.dirname(path).replace(/\//g,'\\');
    return parent==='.'||/\\desktop$/i.test(parent);
  });
  return names.every(matching)
    ?{covered:true,requiredNames:names}
    :{covered:false,reason:'original_file_name_not_covered',requiredNames:names};
}
