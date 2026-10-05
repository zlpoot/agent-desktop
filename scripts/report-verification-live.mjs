import {readdirSync,readFileSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';

const args=process.argv.slice(2);
const index=args.indexOf('--root');
const root=resolve(index<0?process.cwd():args[index+1]);
const dir=resolve(root,'.artifacts/verification-host-shadow');
let files=[];
try {files=readdirSync(dir).filter(name=>name.endsWith('.jsonl')).map(name=>join(dir,name));}
catch(error) {if(error.code!=='ENOENT')throw error;}
if(!files.length) {
  console.log(JSON.stringify({root,records:0,status:'no_new_shadow_records',nextAction:'Run a new task with the updated Host and Worker.'}));
  process.exit(1);
}
const file=files.sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs)[0];
const records=readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map((line,i)=>{
  try{return JSON.parse(line);}catch{throw new Error(`Invalid shadow JSONL at line ${i+1}`);}
});
const stages=records.filter(record=>record.kind==='stage-verification');
const actions=records.filter(record=>record.kind==='action-verification');
const tasks=records.filter(record=>record.kind==='task-verification');
const count=values=>Object.fromEntries([...new Set(values)].map(value=>[value,values.filter(v=>v===value).length]));
const checks=[...actions,...stages,...tasks];
const calls=checks.reduce((total,record)=>total+(record.report?.metrics?.modelCalls??0),0);
const summary={root,taskId:records.at(-1)?.taskId,records:records.length,stageChecks:stages.length,
  actionChecks:actions.length,
  taskChecks:tasks.length,
  taskStatus:count(tasks.map(record=>record.status??'missing')),
  actionStatus:count(actions.map(record=>record.status??'missing')),
  stageStatus:count(stages.map(record=>record.status??'missing')),
  blockedReasons:count(checks.flatMap(record=>record.reasons??[])),
  verdicts:count(checks.map(record=>record.report?.verdict??'no_report')),
  checkReasons:count(checks.flatMap(record=>record.report?.checks?.map(check=>check.reason)??[])),
  modelCalls:calls,
  inputTokens:checks.reduce((total,record)=>total+(record.report?.metrics?.inputTokens??0),0),
  outputTokens:checks.reduce((total,record)=>total+(record.report?.metrics?.outputTokens??0),0),
  usageReported:checks.filter(record=>record.report?.metrics?.usageReported).length,
  modelDurationMs:Math.round(checks.reduce((total,record)=>total+(record.report?.metrics?.durationMs??0),0)),
  note:'Diagnostic counts only; no task outcome or screenshot claims. Raw UI evidence remains in the local JSONL file.'};
console.log(JSON.stringify(summary,null,2));
