import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {inspectShadowEvent} from '../src/verification/shadow.ts';
const args=process.argv.slice(2);
const duration=args.includes('--watch-seconds')?Number(args[args.indexOf('--watch-seconds')+1]):0;
if(!Number.isInteger(duration)||duration<0||duration>60)throw new Error('watch-seconds must be 0..60');
const db=new DatabaseSync(resolve('web-tasks.sqlite'),{readOnly:true});
const output=resolve('.artifacts/verification-shadow',new Date().toISOString().replace(/[:.]/g,'-'));
mkdirSync(output,{recursive:true});
const receipts=[];let historical=0,live=0;
const eligible=new Set(['verify','verify_task','stage_check','stage_completed','finish']);
function record(event,origin) {
  if(!eligible.has(event.node))return;
  const state=JSON.parse(event.payload_json);
  const receipt={origin,...inspectShadowEvent({eventId:event.id,taskId:event.task_id,step:event.step,node:event.node,createdAt:event.created_at,state})};
  // Copy verdict diagnostics only; no screenshots, raw UI text, secrets or mutation methods in this observer.
  receipts.push(receipt);appendFileSync(resolve(output,'receipts.jsonl'),JSON.stringify(receipt)+'\n');
  if(origin==='historical')historical++;else live++;
}
let task;
try {
  // One read snapshot closes the history/live gap, including other tasks inserted during the watch.
  db.exec('BEGIN');
  task=db.prepare('SELECT task_id,status,step FROM tasks ORDER BY updated_at DESC LIMIT 1').get();
  let cursor=db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get().id;
  if(task)for(const row of db.prepare('SELECT * FROM events WHERE task_id=? ORDER BY id').all(task.task_id))record(row,'historical');
  db.exec('COMMIT');
  const deadline=Date.now()+duration*1000;
  while(Date.now()<deadline) {
    await new Promise(r=>setTimeout(r,Math.min(1000,deadline-Date.now())));
    for(const row of db.prepare('SELECT * FROM events WHERE id>? ORDER BY id').all(cursor)) {
      cursor=row.id;record(row,'live');
    }
  }
} finally {db.close();}
const report={createdAt:new Date().toISOString(),task,watchSeconds:duration,
  source:'read-only SQLite; no production hook or network calls',
  hashes:Object.fromEntries(['src/verification/shadow.ts','scripts/observe-verification-shadow.mjs'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')])),
  summary:{historicalEvents:historical,liveEvents:live,evaluated:0,blocked:receipts.length,jevCalls:0,deepseekCalls:0},
  gaps:Object.fromEntries([...new Set(receipts.flatMap(r=>r.missing))].map(g=>[g,receipts.filter(r=>r.missing.includes(g)).length])),
  limitations:['Legacy events lack typed verification contracts and trustworthy capture metadata. No fabricated verdicts.',
    'No measured wait/collection effect or DeepSeek savings. Live observation requires new task events.']};
writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));
