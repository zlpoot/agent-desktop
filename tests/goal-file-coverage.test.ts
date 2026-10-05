import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {auditGoalFileCoverage} from '../src/verification/goal-file-coverage.js';

test('original file name must be present in independently declared file paths',()=>{
  const goal='将准确文本保存为当前用户桌面的 report.txt';
  assert.equal(auditGoalFileCoverage(goal,['report.txt']).covered,true);
  assert.equal(auditGoalFileCoverage(goal,['other.txt']).reason,'original_file_name_not_covered');
  assert.equal(auditGoalFileCoverage(goal,[]).reason,'original_file_name_not_covered');
  assert.equal(auditGoalFileCoverage(goal,['D:\\Other\\report.txt']).covered,false);
  assert.equal(auditGoalFileCoverage(goal,['C:\\Users\\test\\Desktop\\report.txt']).covered,true);
  assert.deepEqual(auditGoalFileCoverage('在窗口 note.txt 保存桌面文件 report.txt',['report.txt']).requiredNames,
    ['report.txt']);
  assert.equal(auditGoalFileCoverage('打开 report.txt',[]).covered,true);
  assert.equal(auditGoalFileCoverage('保存文件到 D:\\Exports\\report.txt',['report.txt']).reason,
    'original_file_path_outside_frozen_desktop_contract');
});

test('the frozen development case with omitted path is blocked without changing dataset labels',()=>{
  const cases=JSON.parse(readFileSync('testbench/verification/v1/development.json','utf8')) as Array<{
    id:string;goal:string;input:{contract:{criteria:Array<{field:string;predicate:{expected?:unknown}}>}}}>;
  const paths=(id:string)=>cases.find(item=>item.id===id)!.input.contract.criteria
    .filter(item=>item.field==='canonicalPath'&&typeof item.predicate.expected==='string')
    .map(item=>item.predicate.expected as string);
  assert.equal(auditGoalFileCoverage(cases.find(item=>item.id==='file-save/pass')!.goal,
    paths('file-save/pass')).covered,true);
  assert.equal(auditGoalFileCoverage(cases.find(item=>item.id==='challenge/contract-omits-path')!.goal,
    paths('challenge/contract-omits-path')).covered,false);
});
