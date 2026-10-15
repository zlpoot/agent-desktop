"""共用 JSON 执行器的合成检查。不启动应用、不导入真实学习记录。"""
import copy
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from learned_replay import LearnedReplay, ReplayError, live_target, load_recipe, validate_recipe


class ReplayTests(unittest.TestCase):
    def setUp(self):
        test_root = Path(__file__).resolve().parents[1] / 'reports' / 'synthetic-tests'
        test_root.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=test_root)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        template = json.loads((Path(__file__).resolve().parent / 'fixtures/replay.template.json').read_text(encoding='utf-8'))
        template['application']['executable'] = str(self.root / 'synthetic.exe')
        self.template = template
        self.template_path = self.root / 'template.json'
        self.template_path.write_text(json.dumps(template), encoding='utf-8')
        self.learned_path = self.root / 'learned.json'
        self.f = SimpleNamespace(value='', instance='fake-instance', fp='a' * 64, full=0,
                                 actions=0, clicks=0, stale=False, capture_fail=False, fail_click=False,
                                 closed=[], threads=[], button_name='search', target_count=1)
        f = self.f
        class Api:
            def window_class(_self, hwnd): return 'SyntheticWindow'
            def screen_to_client(_self, hwnd, x, y): return x, y
        class Desktop:
            api = Api()
            def click(_self, hwnd, x, y, double=False):
                f.clicks += 1
                if f.fail_click: raise ReplayError('dispatch-effect-unknown')
                return {'dispatched': True}
        self.desktop = desktop = Desktop()
        class Tree:
            def __init__(_self, *_):
                _self.owner = threading.get_ident()
                _self.elements, _self.hwnd, _self.desktop = [object()], 123, desktop
            def guard(_self):
                self.assertEqual(_self.owner, threading.get_ident())
                f.threads.append(threading.get_ident())
            def _string(_self, element, slot):
                _self.guard()
                return f.value if _self.role == 'Edit' else f.button_name
            def _integer(_self, element, slot):
                _self.guard()
                return 0
            def prove_target(_self, row):
                _self.guard()
                if f.stale: raise ReplayError('bound-target-changed')
                return {'runtimeId': [7], 'identityRebound': True}
            def value(_self, index):
                _self.guard()
                return f.value
            def set_value(_self, index, value):
                _self.guard()
                f.value = value
                f.actions += 1
            def close(_self):
                _self.guard()
                f.closed.append(id(_self))
        class Lab:
            actions, max_actions = 0, 256
            def _target_window(_self): return desktop, 123
            def _do_verify_target_identity(_self, args):
                return {'ok': True, 'alive': True, 'image': template['application']['executable'],
                        'pid': 7, 'session': 5, 'instanceId': f.instance, 'desktopName': 'fake-owned'}
            def _locate(_self, tree, selector):
                f.full += 1
                if f.target_count != 1: raise ReplayError('target-not-unique')
                tree.role = selector['role']
                return {'index': 0, 'role': 50004 if tree.role == 'Edit' else 50000,
                        'roleName': tree.role, 'name': f.value if tree.role == 'Edit' else f.button_name,
                        'autoId': '', 'className': '', 'runtimeId': [7], 'native': 0,
                        'rect': [1, 1, 20, 20], 'identity': {'globalUnique': True}}
            def invoke(_self, name, args):
                if name == 'observe.window.enumerate':
                    result = {'items': [{'owned': True, 'root': True, 'hwnd': 123, 'className': 'SyntheticWindow'}]}
                elif name == 'locate.window': result = {'target': 123}
                elif name == 'observe.capture':
                    if f.capture_fail: raise ReplayError('preview-budget')
                    result = {'token': 'synthetic-frame', 'unrendered': False}
                elif name == 'env.identity.probe': result = {'hiddenDesktopOpen': True}
                elif name == 'env.app.launch': result = {'pid': 7}
                else: result = {}
                return {'result': result}
        self.lab = Lab()
        self.tree_factory = Tree
        self.runner = self.make_runner()

    def make_runner(self):
        runner = LearnedReplay(self.lab, threading.RLock(), self.template_path, self.learned_path,
                               lambda info: None, tree_factory=self.tree_factory,
                               fingerprint_fn=lambda path: {'path': path, 'size': 1, 'sha256': self.f.fp})
        self.addCleanup(runner.shutdown)
        return runner

    def run_action(self, action, inputs=None, runner=None):
        runner = runner or self.runner
        job_id = runner.start(action, inputs)
        runner.executor.submit(lambda: None).result(timeout=5)
        return runner.status(job_id)

    def learn(self):
        job = self.run_action('learn')
        self.assertEqual(job['status'], 'done', job)
        return job

    def test_learning_saves_only_json_and_full_queries_happen_once(self):
        self.assertTrue(self.runner.summary()['learningRequired'])
        learned = self.learn()
        recipe = load_recipe(self.learned_path, True)
        self.assertEqual(recipe['learning']['applicationFingerprint']['sha256'], 'a' * 64)
        self.assertNotIn('runtimeId', recipe['learning']['targets']['search'])
        self.assertNotIn('hwnd', json.dumps(recipe))
        self.assertEqual(recipe['learning']['validation'], 'targets-and-patterns-only')
        self.assertEqual(self.f.full, 2)
        job = self.run_action('synthetic.locateSearch')
        self.assertEqual(job['output']['fullQueries'], 0)
        self.assertEqual(self.f.full, 2)
        self.assertEqual(self.f.actions, 0)
        self.assertEqual(self.f.clicks, 0)

    def test_replay_reads_fresh_values_and_never_requeries_the_tree(self):
        self.learn()
        fill = self.run_action('synthetic.fillSearch', {'query': 'synthetic term'})
        self.assertEqual(fill['status'], 'done', fill)
        self.assertEqual(fill['output']['verifiedValue'], 'synthetic term')
        self.assertEqual(self.f.full, 2)
        self.assertEqual(self.lab.actions, 1)
        submit = self.run_action('synthetic.submitSearch', {'query': 'synthetic term'})
        self.assertEqual(submit['verification']['status'], '待人工核对')
        self.assertEqual(self.f.clicks, 1)
        self.assertEqual(self.f.full, 2)
        self.assertEqual(self.lab.actions, 2)
        proof = next(c['result']['identity'] for c in submit['calls'] if c['capability'] == 'replay.target.live')
        self.assertIsNone(proof['globalUnique'])
        self.assertEqual(proof['evidence'], 'current-properties-and-ancestry')
        again = self.run_action('synthetic.submitSearch', {'query': 'synthetic term'})
        self.assertEqual(again['status'], 'failed')
        self.assertEqual(self.f.clicks, 1)

    def test_json_can_rebind_in_a_new_runtime_without_generating_any_script(self):
        self.learn()
        other = self.make_runner()
        job = self.run_action('synthetic.locateSearch', runner=other)
        self.assertEqual(job['status'], 'done', job)
        self.assertEqual(job['output']['fullQueries'], 2)
        self.assertEqual(other.summary()['values'], {})
        files = {p.name for p in self.root.iterdir()}
        self.assertEqual(files, {'template.json', 'learned.json'})

    def test_missing_learning_and_invalid_parameters_stop_before_input(self):
        job = self.run_action('synthetic.fillSearch', {'query': 'term'})
        self.assertEqual(job['error'], 'learning-required')
        self.learn()
        for value in ('', 'a' * 201, None):
            job = self.run_action('synthetic.fillSearch', {'query': value})
            self.assertEqual(job['status'], 'failed')
            self.assertEqual(self.f.actions, 0)
            self.learn()

    def test_version_change_requires_relearning_and_drops_all_references(self):
        self.learn()
        self.f.fp = 'b' * 64
        job = self.run_action('synthetic.fillSearch', {'query': 'term'})
        self.assertEqual(job['error'], 'application-version-changed-learning-required')
        self.assertFalse(self.runner.summary()['bound'])
        self.assertEqual(len(self.f.closed), 2)
        self.assertEqual(self.f.actions, 0)
        self.learn()
        self.assertEqual(load_recipe(self.learned_path, True)['learning']['applicationFingerprint']['sha256'], 'b' * 64)

    def test_instance_change_or_stale_target_does_not_fallback_or_input(self):
        for mode in ('instance', 'target', 'button-name'):
            self.run_action('reset')
            self.f.stale, self.f.button_name = False, 'search'
            self.learn()
            if mode == 'instance': self.f.instance += '-new'
            elif mode == 'target': self.f.stale = True
            else: self.f.button_name = 'other'
            job = self.run_action('synthetic.locateSearch')
            self.assertEqual(job['status'], 'failed', mode)
            self.assertFalse(self.runner.summary()['bound'])
            self.assertEqual(self.f.actions, 0)
            self.assertEqual(self.f.clicks, 0)

    def test_direct_value_verification_checks_actual_not_old_record(self):
        self.learn()
        self.run_action('synthetic.fillSearch', {'query': 'term'})
        self.f.value = 'changed by app'
        job = self.run_action('synthetic.submitSearch', {'query': 'term'})
        self.assertEqual(job['error'], 'value-verification-failed')
        self.assertEqual(self.f.clicks, 0)

    def test_click_effect_unknown_consumes_input_and_counts_budget_no_retry(self):
        self.learn()
        self.run_action('synthetic.fillSearch', {'query': 'term'})
        self.f.fail_click = True
        job = self.run_action('synthetic.submitSearch', {'query': 'term'})
        self.assertEqual(job['error'], 'dispatch-effect-unknown')
        self.assertEqual(self.f.clicks, 1)
        self.assertEqual(self.lab.actions, 2)
        self.assertFalse(self.runner.summary()['bound'])
        self.run_action('synthetic.submitSearch', {'query': 'term'})
        self.assertEqual(self.f.clicks, 1)

    def test_budget_failure_prevents_all_input(self):
        self.learn()
        self.lab.actions = self.lab.max_actions
        job = self.run_action('synthetic.fillSearch', {'query': 'term'})
        self.assertEqual(job['error'], 'budget-exhausted')
        self.assertEqual(self.f.actions, 0)

    def test_capture_failure_is_separate_and_does_not_repeat_input(self):
        self.learn()
        self.f.capture_fail = True
        job = self.run_action('synthetic.fillSearch', {'query': 'term'})
        self.assertEqual(job['status'], 'done')
        self.assertEqual(job['previewError'], 'preview-budget')
        self.assertEqual(self.f.actions, 1)

    def test_duplicate_targets_fail_learning_and_leave_no_json_or_com_bindings(self):
        self.f.target_count = 2
        job = self.run_action('learn')
        self.assertEqual(job['status'], 'failed')
        self.assertFalse(self.learned_path.exists())
        self.assertFalse(self.runner.summary()['bound'])
        self.assertEqual(len(self.f.closed), 1)

    def test_all_com_operations_and_cleanup_stay_on_one_worker_thread(self):
        self.learn()
        self.run_action('synthetic.fillSearch', {'query': 'term'})
        self.runner.invalidate()
        self.assertEqual(len(self.f.closed), 2)
        self.assertEqual(len(set(self.f.threads)), 1)
        self.assertNotIn(threading.get_ident(), self.f.threads)
        self.assertTrue(self.learned_path.exists())

    def test_schema_refuses_code_unknown_op_and_unsupported_schema(self):
        for change in ('script', 'version', 'wait', 'dynamic-button'):
            bad = copy.deepcopy(self.template)
            if change == 'script': bad['operations'][0]['steps'][0]['op'] = 'eval'
            elif change == 'version': bad['schemaVersion'] = 99
            elif change == 'wait': bad['operations'][0]['steps'][0] = {'op': 'wait', 'milliseconds': 999999}
            else: bad['targets']['submit']['namePolicy'] = 'dynamic'
            with self.assertRaises(ReplayError): validate_recipe(bad)

    def test_parameters_and_operation_ids_are_data_not_task_branches(self):
        data = copy.deepcopy(self.template)
        data['parameters']['term'] = data['parameters'].pop('query')
        for op in data['operations']:
            op['id'] = op['id'].replace('synthetic.', 'other.')
            op['inputs'] = ['term' if p == 'query' else p for p in op['inputs']]
            if op.get('requiresState'): op['requiresState']['parameter'] = 'term'
            for step in op['steps']:
                if 'parameter' in step: step['parameter'] = 'term'
        self.template_path.write_text(json.dumps(data), encoding='utf-8')
        self.learn()
        job = self.run_action('other.fillSearch', {'term': 'another app recipe'})
        self.assertEqual(job['status'], 'done', job)
        self.assertEqual(self.f.value, 'another app recipe')

    def test_concurrent_requests_refuse_and_progress_exposes_current_call(self):
        entered, release = threading.Event(), threading.Event()
        original = self.lab._locate
        def blocked(tree, selector):
            entered.set()
            if not release.wait(3): raise ReplayError('synthetic-timeout')
            return original(tree, selector)
        self.lab._locate = blocked
        job_id = self.runner.start('learn')
        try:
            self.assertTrue(entered.wait(2))
            with self.assertRaisesRegex(ReplayError, 'replay-busy'):
                self.runner.start('learn')
            job = self.runner.status(job_id)
            self.assertEqual(job['calls'][-1]['status'], '执行中')
            self.assertEqual(job['calls'][-1]['capability'], 'learn.locate.structured')
        finally:
            release.set()
        self.runner.executor.submit(lambda: None).result(timeout=4)
        self.assertEqual(self.runner.status(job_id)['status'], 'done')

    def test_missing_learned_target_parameters_requests_relearning(self):
        self.learn()
        recipe = load_recipe(self.learned_path, True)
        del recipe['learning']['targets']['search']['autoId']
        self.learned_path.write_text(json.dumps(recipe), encoding='utf-8')
        self.assertTrue(self.runner.summary()['learningRequired'])
        self.assertEqual(self.run_action('synthetic.locateSearch')['error'], 'invalid-learning-json')
        self.learn()
        self.assertFalse(self.runner.summary()['learningRequired'])

    def test_old_references_are_not_reused_after_json_changes(self):
        self.learn()
        recipe = load_recipe(self.learned_path, True)
        recipe['revision'] += 1
        self.learned_path.write_text(json.dumps(recipe), encoding='utf-8')
        job = self.run_action('synthetic.locateSearch')
        self.assertEqual(job['status'], 'done', job)
        self.assertEqual(job['output']['fullQueries'], 2)
        self.assertEqual(len(self.f.closed), 2)

    def test_operation_learning_only_saves_after_page_verification(self):
        self.learn()
        original = self.learned_path.read_bytes()
        op = {'id': 'synthetic.detail', 'title': 'Detail', 'description': 'Synthetic only',
              'inputs': [], 'learningRequired': True, 'steps': [
                  {'op': 'observe_page'}, {'op': 'assert_rows', 'match': {'role':50020,'name':'Synthetic'}},
                  {'op':'capture'}]}
        template=copy.deepcopy(self.template)
        template['operations'].append(op)
        self.template_path.write_text(json.dumps(template),encoding='utf-8')
        class Observation:
            def __init__(_self,tree,environment):
                _self.rows=[];_self.window=[0,0,100,100];_self.environment=environment
            def check(_self,*args):raise ValueError('synthetic-wrong-detail')
        with patch('learned_replay.PageObservation',Observation):
            failed=self.run_action('learn:synthetic.detail')
        self.assertEqual(failed['error'],'synthetic-wrong-detail')
        self.assertEqual(self.learned_path.read_bytes(),original)
        self.run_action('reset')
        Observation.check=lambda _self,spec,*args: dict(predicate=spec,count=1,complete=True,scope='all-descendants')
        original_capture=self.runner._capture
        self.runner._capture=lambda: {'sha256':'b'*64,'capturedAt':'synthetic-time'}
        with patch('learned_replay.PageObservation',Observation):
            saved=self.run_action('learn:synthetic.detail')
        self.runner._capture=original_capture
        self.assertEqual(saved['status'],'done',saved)
        recipe=load_recipe(self.learned_path,True)
        self.assertIn('synthetic.detail',recipe['learning']['verifiedOperations'])
        self.assertNotIn('runtimeId',json.dumps(recipe['learning']['verifiedOperations']))
        recipe['operations'][-1]['steps'][1]['match']['name']='Changed'
        self.learned_path.write_text(json.dumps(recipe),encoding='utf-8')
        self.assertEqual(self.run_action('synthetic.detail')['error'],'operation-changed-learning-required')

    def test_page_click_budget_and_unknown_effect_stop_without_save_or_retry(self):
        self.learn()
        original=self.learned_path.read_bytes()
        match={'role':50020,'name':'Synthetic'}
        operation={'id':'synthetic.page','title':'Page','description':'Synthetic','inputs':[],
                   'learningRequired':True,'steps':[{'op':'observe_page'},
                   {'op':'click_match','match':match},{'op':'observe_page'},
                   {'op':'assert_rows','match':match},{'op':'capture'}]}
        template=copy.deepcopy(self.template);template['operations'].append(operation)
        self.template_path.write_text(json.dumps(template),encoding='utf-8')
        class Observation:
            def __init__(_self,tree,environment):
                _self.rows=[];_self.window=[0,0,100,100];_self.environment=environment
            def check(_self,spec,*args):
                return {'matches':[{'native':0,'rect':[10,10,30,30]}]}
        self.lab.max_actions=0
        with patch('learned_replay.PageObservation',Observation):
            job=self.run_action('learn:synthetic.page')
        self.assertEqual(job['error'],'budget-exhausted')
        self.assertEqual(self.f.clicks,0)
        self.assertEqual(self.learned_path.read_bytes(),original)

        self.run_action('reset');self.lab.max_actions=256;self.f.fail_click=True
        with patch('learned_replay.PageObservation',Observation):
            job=self.run_action('learn:synthetic.page')
        self.assertEqual(job['error'],'dispatch-effect-unknown')
        self.assertEqual(self.f.clicks,1)
        self.assertEqual(self.lab.actions,1)
        self.assertEqual(self.learned_path.read_bytes(),original)

    def test_bound_control_state_is_read_live_and_changes_only_once(self):
        self.learn()
        operation={'id':'synthetic.state','title':'State','description':'Synthetic','inputs':[],
            'learningRequired':True,'steps':[{'op':'observe_page'},
                {'op':'bind_match','binding':'toggle','match':{'role':50011,'autoId':'synthetic_toggle'}},
                {'op':'ensure_state','binding':'toggle','desiredName':'play','actionName':'pause'},
                {'op':'observe_page'},{'op':'assert_rows','match':{'role':50020,'name':'Synthetic'}},{'op':'capture'}]}
        template=copy.deepcopy(self.template);template['operations'].append(operation)
        self.template_path.write_text(json.dumps(template),encoding='utf-8')
        f=self.f
        class Observation:
            def __init__(_self,tree,environment):
                tree.role='MenuItem';_self.rows=[];_self.window=[0,0,100,100];_self.environment=environment
            def check(_self,spec,*args):
                return dict(matches=[dict(index=0,role=50011,roleName='MenuItem',name=f.button_name,
                    native=0,rect=[10,10,30,30],runtimeId=[7],autoId='synthetic_toggle',className='')],
                    predicate=spec,count=1,complete=True,scope='all-descendants')
        def click(*args,**kwargs):f.clicks+=1;f.button_name='play';return {'dispatched':True}
        self.desktop.click=click
        self.runner._capture=lambda:dict(sha256='b'*64,capturedAt='synthetic')
        f.button_name='pause'
        with patch('learned_replay.PageObservation',Observation):
            job=self.run_action('learn:synthetic.state')
        self.assertEqual(job['status'],'done',job)
        self.assertEqual(f.clicks,1)
        self.assertEqual(f.button_name,'play')
        f.button_name='unexpected'
        with patch('learned_replay.PageObservation',Observation):
            failed=self.run_action('synthetic.state')
        self.assertEqual(failed['error'],'unexpected-control-state')
        self.assertEqual(f.clicks,1)
        self.run_action('reset')
        template['operations'][-1]['description']='Changed definition requires learning'
        self.template_path.write_text(json.dumps(template),encoding='utf-8')
        self.assertIn('synthetic.state',self.runner.summary()['unlearnedOperations'])
        changed=self.run_action('synthetic.state')
        self.assertEqual(changed['error'],'operation-changed-learning-required')
        self.assertEqual(f.clicks,1)



if __name__ == '__main__':
    unittest.main()
