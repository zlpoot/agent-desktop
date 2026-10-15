"""独立 JSON 能力和整体流程的合成检查；不读取真实学习文件、不启动应用。"""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from learned_replay import validate_recipe, ReplayError
from skill_composition import (SkillLibrary, CompositionError, binding_contract, digest,
                               resolve_value, substitute, validate_workflow, workflow_inputs)
import test_learned_replay as fixtures


class CompositionTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.ReplayTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.f.learn()
        self.root=self.f.root
        self.directory=self.root/'capabilities';self.directory.mkdir()
        saved=json.loads(self.f.learned_path.read_text(encoding='utf-8'))
        self.recipes=[]
        for operation in saved['operations'][1:4]:
            recipe=copy.deepcopy(saved)
            operation=copy.deepcopy(operation)
            operation['id']={'synthetic.locateSearch':'synthetic.bind','synthetic.fillSearch':'synthetic.fill',
                             'synthetic.submitSearch':'synthetic.submit'}[operation['id']]
            recipe.update(id=operation['id'],revision=1,kind='learned-capability',operations=[operation])
            self.recipes.append(recipe)
            self.write_capability(recipe)
        self.workflow={'schemaVersion':1,'kind':'workflow','id':'synthetic.workflow','revision':1,'title':'Synthetic',
            'completion':'Synthetic completed','automaticRetry':False,'onFailure':'stop',
            'parameters':{'song':{'type':'string','maxLength':140,'default':'Synthetic Song'},
                          'artist':{'type':'string','maxLength':40,'default':'Synthetic Artist'}},'steps':[]}
        for index,recipe in enumerate(self.recipes):
            self.workflow['steps'].append({'id':f'step-{index+1}','capability':recipe['id'],'revision':1,
                'definitionSha256':digest(recipe),'inputs':{'query':{'join':[{'input':'song'},{'input':'artist'}],
                    'separator':' '}} if index else {}})
        self.path=self.root/'workflow.json';self.write_workflow()
        self.library=SkillLibrary(self.path,self.directory,validate_recipe)
        self.f.runner.library=self.library
        self.f.run_action('reset')

    def write_capability(self,recipe):
        (self.directory/(recipe['id']+'.json')).write_text(json.dumps(recipe),encoding='utf-8')

    def write_workflow(self):self.path.write_text(json.dumps(self.workflow),encoding='utf-8')

    def test_whole_flow_calls_separate_json_and_transfers_only_identical_bindings(self):
        before=self.f.f.full
        job=self.f.run_action('workflow:synthetic.workflow')
        self.assertEqual(job['status'],'done',job)
        self.assertEqual([s['status'] for s in job['workflow']['steps']],['done']*3)
        self.assertEqual(self.f.f.value,'Synthetic Song Synthetic Artist')
        self.assertEqual(self.f.f.full-before,2)
        self.assertEqual(self.f.f.clicks,1)
        self.assertTrue(any(c['capability']=='replay.binding.transfer' for c in job['calls']))
        # 最后一个子能力仍要求人工验收时，不能将整体标成自动通过。
        self.assertEqual(job['verification']['status'],'待人工核对')
        self.assertEqual(job['verification']['evidence'],'Synthetic completed')
        self.assertTrue(all(c.get('workflowStep') for c in job['calls']))

    def test_each_sub_capability_can_be_called_independently_with_same_executor(self):
        for capability_id,inputs in [('synthetic.bind',{}),('synthetic.fill',{'query':'explicit term'}),
                                     ('synthetic.submit',{'query':'explicit term'})]:
            job=self.f.run_action('capability:'+capability_id,inputs)
            self.assertEqual(job['status'],'done',job)
        self.assertEqual(self.f.f.value,'explicit term')
        self.assertEqual(self.f.f.clicks,1)

    def test_changed_dependency_refused_in_preflight_before_effects(self):
        changed=copy.deepcopy(self.recipes[-1]);changed['operations'][0]['description']='Changed'
        self.write_capability(changed)
        job=self.f.run_action('workflow:synthetic.workflow')
        self.assertIn('capability-definition-changed',job['error'])
        self.assertEqual(self.f.f.actions,0)
        self.assertEqual(self.f.f.clicks,0)

    def test_optional_album_defaults_empty_but_required_song_stays_required(self):
        self.workflow['parameters']['album']={'type':'string','maxLength':140,'required':False,'default':''}
        validate_workflow(self.workflow)
        self.assertEqual(workflow_inputs(self.workflow,{})['album'],'')
        self.assertEqual(workflow_inputs(self.workflow,{'album':'Studio'})['album'],'Studio')
        with self.assertRaises(CompositionError):workflow_inputs(self.workflow,{'song':''})
        self.workflow['parameters']['album']['required']='false'
        with self.assertRaises(CompositionError):validate_workflow(self.workflow)

    def test_optional_capability_parameter_can_be_empty_without_relaxing_required_parameters(self):
        recipe=copy.deepcopy(self.recipes[1])
        recipe['parameters']['album']={'type':'string','minLength':0,'maxLength':140,'required':False,'default':''}
        validate_recipe(recipe,True)
        recipe['parameters']['album']['required']=True
        with self.assertRaises(ReplayError):validate_recipe(recipe,True)

    def test_failed_child_stops_later_children_and_does_not_retry(self):
        self.f.f.target_count=2
        job=self.f.run_action('workflow:synthetic.workflow')
        self.assertEqual(job['status'],'failed')
        self.assertEqual([s['status'] for s in job['workflow']['steps']],['failed','pending','pending'])
        self.assertEqual(self.f.f.actions,0)
        self.assertEqual(self.f.f.clicks,0)
        again=self.f.run_action('workflow:synthetic.workflow')
        self.assertEqual(again['error'],'reset-or-learning-required')

    def test_instance_change_between_steps_fails_without_click(self):
        original=self.f.runner._run_capability
        def run(recipe,inputs):
            result=original(recipe,inputs)
            if recipe['id']=='synthetic.fill':self.f.f.instance='other-instance'
            return result
        self.f.runner._run_capability=run
        job=self.f.run_action('workflow:synthetic.workflow')
        self.assertEqual(job['status'],'failed')
        self.assertEqual(job['workflow']['steps'][1]['status'],'failed')
        self.assertEqual(self.f.f.clicks,0)

    def test_incompatible_binding_contract_is_dropped_before_input(self):
        self.f.run_action('capability:synthetic.bind')
        changed=copy.deepcopy(self.recipes[1]);changed['targets']['search']['selector']['value']='other'
        self.write_capability(changed)
        job=self.f.run_action('capability:synthetic.fill',{'query':'term'})
        self.assertEqual(job['error'],'binding-required')
        self.assertEqual(self.f.f.actions,0)

    def test_unknown_and_invalid_parameters_cannot_reach_runtime(self):
        for inputs in ({'song':''},{'song':'a'*141},{'unexpected':'x'}):
            with self.assertRaises(CompositionError):self.library.plan(inputs)
        self.assertEqual(self.f.f.actions,0)

    def test_library_rejects_path_traversal_and_modified_kind(self):
        for identifier in ('../outside','/absolute','a..b',''):
            with self.assertRaises(CompositionError):self.library.capability(identifier)
        bad=copy.deepcopy(self.recipes[0]);bad['kind']='workflow';self.write_capability(bad)
        with self.assertRaisesRegex(CompositionError,'invalid-standalone'):
            self.library.capability(bad['id'])

    def test_duplicate_steps_unknown_inputs_and_code_expressions_refused(self):
        bad=copy.deepcopy(self.workflow);bad['steps'][1]['id']=bad['steps'][0]['id']
        with self.assertRaises(CompositionError):validate_workflow(bad)
        for value in ({'eval':'code'},{'input':'missing'},{'join':[],'separator':' '}):
            with self.assertRaises(CompositionError):resolve_value(value,{'song':'s'})
        self.assertEqual(substitute({'name':'${song}'},{'song':'quoted " text'}),{'name':'quoted " text'})
        with self.assertRaises(CompositionError):substitute('${missing}',{})

    def test_ensure_application_reuses_only_owned_matching_application(self):
        recipe=copy.deepcopy(self.recipes[0]);recipe['operations'][0]['steps']=[{'op':'ensure_app'}]
        self.write_capability(recipe)
        self.f.lab.facts=lambda:{'ownedAppRunning':True}
        job=self.f.run_action('capability:synthetic.bind')
        self.assertEqual(job['status'],'done',job)
        self.assertTrue(job['output']['reusedOwnedApplication'])
        self.assertFalse(any(c['capability']=='env.app.launch' for c in job['calls']))

    def test_capability_parameter_substitution_reaches_page_executor_as_literal_data(self):
        recipe=copy.deepcopy(self.recipes[0]);recipe['operations'][0].update(inputs=['query'],steps=[
            {'op':'observe_page'},{'op':'assert_rows','match':{'role':50020,'name':'${query}'}}])
        self.write_capability(recipe)
        captured=[]
        self.f.runner._page_operation=lambda r,o:captured.append(o) or {'checks':[]}
        job=self.f.run_action('capability:synthetic.bind',{'query':'literal ${not-code}'})
        self.assertEqual(job['status'],'done',job)
        self.assertEqual(captured[0]['steps'][1]['match']['name'],'literal ${not-code}')

    def test_preview_warning_clears_after_independent_successful_capture(self):
        self.f.runner.job={'calls':[]}
        self.f.f.capture_fail=True;self.f.runner._capture()
        self.assertIn('previewError',self.f.runner.job)
        self.f.f.capture_fail=False;self.f.runner._capture()
        self.assertNotIn('previewError',self.f.runner.job)


if __name__=='__main__':unittest.main()
