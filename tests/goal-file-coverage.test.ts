import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {auditGoalFileCoverage,desktopFileExpectationsFromGoal} from '../src/verification/goal-file-coverage.js';

test('original file name must be present in independently declared file paths',()=>{
  const goal='将准确文本保存为当前用户桌面的 report.txt';
  assert.equal(auditGoalFileCoverage(goal,['report.txt']).covered,true);
  assert.equal(auditGoalFileCoverage('不修改原文而另存为桌面 report.txt',[]).covered,false);
  assert.equal(auditGoalFileCoverage('禁止点击、输入，然后保存为桌面 report.txt',[]).covered,false);
  assert.equal(auditGoalFileCoverage('Do not click, type; then save report.txt',[]).covered,false);
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

test('readonly HTTP targets and prohibited output verbs do not create Desktop file requirements',()=>{
  const url='http://127.0.0.1:4180/readonly.html';
  for(const goal of [
    `只读，不点击、输入、下载或登录。完成条件：URL 为 ${url}。禁止文件或站点写入。`,
    `仅打开 ${url}；禁止下载文件 readonly.html，禁止写入文件。`,
    `Read-only. Do not click, type, download or login. Final URL: ${url}.`,
    `不要保存 readonly.html；不必创建文件 readonly.html。`,
  ]) {
    assert.deepEqual(desktopFileExpectationsFromGoal(goal),[]);
    assert.deepEqual(auditGoalFileCoverage(goal,[]),{covered:true,requiredNames:[]});
  }
});

test('a positive output after a prohibition still requires independent file evidence',()=>{
  const goal='不要下载 source.html；将正文保存为桌面 report.txt';
  assert.deepEqual(desktopFileExpectationsFromGoal(goal).map(file=>file.path),['report.txt']);
  assert.equal(auditGoalFileCoverage(goal,[]).covered,false);
  assert.equal(auditGoalFileCoverage(goal,['report.txt']).covered,true);
  const withUrl='从 http://example.test/source.html 读取正文，保存为桌面 report.txt';
  assert.equal(auditGoalFileCoverage(withUrl,['report.txt']).covered,true);
  const afterUrl='保存为桌面 report.txt，来源 http://example.test/source.html';
  assert.deepEqual(auditGoalFileCoverage(afterUrl,['report.txt']).requiredNames,['report.txt']);
  assert.equal(auditGoalFileCoverage(afterUrl,['report.txt']).covered,true);
  assert.equal(auditGoalFileCoverage('下载 http://example.test/source.html',[]).covered,false);
  assert.equal(auditGoalFileCoverage('保存 http://example.test/source.html 到 D:\\Exports\\report.txt',
    ['report.txt']).reason,'original_file_path_outside_frozen_desktop_contract');
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
