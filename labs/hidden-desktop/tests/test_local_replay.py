"""局部探测和暖绑定的合成检查；禁止用真实快照代替性能实测。"""
import copy
import ctypes as C
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import uia_client as uia
from local_replay import LocalBindings, RelearnRequired, TargetQueryError, validate_local_profile
from learned_replay import validate_recipe
import test_learned_replay as fixtures


PROFILE = {'version':1,'mode':'bound-targets-local-probes','coordinateSpace':'physical-window',
 'scopePolicy':'control-view-visible-ancestor-containment','layout':{'width':1600,'height':1000},
 'maxNodes':256,'maxDepth':16,'maxCachedQueries':32,'maxRetainedElements':2000}


def node(name='',role=50026,box=None,children=None,**extra):
    return dict(name=name,role=role,rect=box or [0,0,0,0],children=children or [],**extra)


class RawFixture:
    def __init__(self, root):
        self.registry={};self.closed=[];self.forbidden=0;self.cached_navigation=0;self.cache_properties=[]
        def parents(n,parent=None):
            n['parent']=parent
            for child in n['children']:parents(child,n)
        parents(root)
        owner=self
        class Com:
            def __init__(_self,kind,n=None):
                _self.kind,_self.node=kind,n
                _self.pointer=C.c_void_p(len(owner.registry)+1);owner.registry[_self.pointer.value]=_self
            def close(_self):
                if _self.pointer is not None:owner.closed.append(id(_self));_self.pointer=None
            def call(_self,slot,args=(),values=()):
                if _self.kind=='client':
                    if slot not in (14,16,18,20):owner.forbidden+=1;raise AssertionError('FindAll/client queries forbidden')
                    out=Com({20:'cache',18:'view'}.get(slot,'walker'));values[0]._obj.value=out.pointer.value;return
                if _self.kind=='cache':
                    if slot==3:owner.cache_properties.append(values[0])
                    elif slot==7:assert values[0]==2
                    elif slot==11:assert values[0]==1
                    elif slot==9:assert owner.registry[values[0].value].kind=='view'
                    else:raise AssertionError(slot)
                    return
                if _self.kind=='walker':
                    n=owner.registry[values[0].value].node
                    cached=slot in (10,12)
                    if cached:owner.cached_navigation+=1;slot={10:4,12:6}[slot]
                    if slot==4:found=n['children'][0] if n['children'] else None
                    elif slot==6:
                        siblings=n['parent']['children'];index=next(i for i,x in enumerate(siblings) if x is n)
                        found=siblings[index+1] if index+1<len(siblings) else None
                    else:raise AssertionError(slot)
                    if found:
                        out=Com('node',found);values[2 if cached else 1]._obj.value=out.pointer.value
                    return
                if _self.kind=='snapshot' and slot==19:
                    out=Com('array',_self.node['children']);values[0]._obj.value=out.pointer.value;return
                if _self.kind=='array' and slot==4:
                    out=Com('node',_self.node[values[0]]);values[1]._obj.value=out.pointer.value;return
                if _self.kind=='node' and slot==9:
                    owner.cached_navigation+=1
                    out=Com('snapshot',_self.node);values[1]._obj.value=out.pointer.value;return
                if slot in (43,75):
                    rect=values[0]._obj;rect.left,rect.top,rect.right,rect.bottom=_self.node['rect'];return
                raise AssertionError(('unexpected COM call',slot))
        tree=object.__new__(uia.UiaTree)
        tree.elements=[];tree.client=Com('client');tree.root=Com('node',root)
        tree.hwnd=123;tree.binding={'instance':'synthetic'}
        tree.window_binding=lambda:dict(tree.binding)
        tree.desktop=SimpleNamespace(windows=lambda:[123],api=SimpleNamespace(capture_dpi=lambda:None,
            window_rect=lambda hwnd:[0,0,1600,1000]))
        def owned(element,windows,**kwargs):
            if element.node.get('foreign'):raise uia.UiaError('uia-element-process-mismatch')
            if element.node.get('password'):raise uia.UiaError('uia-password-element-forbidden')
        tree._owned=owned
        tree._integer=lambda e,s:len(e.node) if e.kind=='array' and s==3 else {21:e.node['role'],38:e.node.get('offscreen',False),
                                  28:True,36:e.node.get('native',0)}[s-32 if s>=52 else s]
        tree._string=lambda e,s:{23:e.node['name'],29:e.node.get('autoId',''),30:''}[s-32 if s>=55 else s]
        tree.runtime_id=lambda e:[id(e.node)]
        self.tree=tree

    def query(self,region,budget=256,depth=16):
        with patch.object(uia,'Com',lambda pointer:self.registry[pointer.value]):
            return self.tree.local_rows(region,budget,depth)


class LocalTraversalTests(unittest.TestCase):
    def test_navigation_prefetch_is_element_scoped_and_does_not_skip_later_candidates(self):
        fixture=RawFixture(node(children=[node('First',50020,[400,350,500,380]),
                                          node('Later',50020,[400,450,500,480])]))
        rows=fixture.query([.2,.2,.9,.8])
        self.assertEqual([r['name'] for r in rows],['First','Later'])
        self.assertGreater(fixture.cached_navigation,0)
        self.assertEqual(set(fixture.cache_properties),{30001,30002,30003,30005,30010,30011,30012,30019,30020,30022})
        self.assertEqual(fixture.tree.local_stats['propertyReadStrategy'],'fresh-control-view-children-batch')
        self.assertEqual(fixture.forbidden,0)

    def test_batch_failure_releases_cache_arrays_and_elements_without_fallback(self):
        fixture=RawFixture(node(children=[node('foreign',50020,[400,350,500,380],foreign=True)]))
        with self.assertRaisesRegex(uia.UiaError,'process-mismatch'):
            fixture.query([.2,.2,.9,.8])
        self.assertEqual(fixture.tree.elements,[])
        transient=[c for c in fixture.registry.values() if c.kind in ('cache','snapshot','array','view')]
        self.assertTrue(transient)
        self.assertTrue(all(c.pointer is None for c in transient))
        self.assertEqual(fixture.forbidden,0)

    def test_invalid_batch_count_cannot_reduce_node_budget_or_claim_completeness(self):
        fixture=RawFixture(node(children=[node('candidate',50020,[400,350,500,380])]))
        original=fixture.tree._integer
        fixture.tree._integer=lambda element,slot:-1 if element.kind=='array' else original(element,slot)
        with self.assertRaisesRegex(uia.UiaError,'invalid-children-count'):
            fixture.query([.2,.2,.9,.8])
        self.assertEqual(fixture.tree.elements,[])
    def test_first_visible_policy_is_explicit_local_and_records_actual_candidates(self):
        from local_replay import LocalObservation
        from replay_observation import PageObservation
        rows=[dict(index=i,role=50020,name='Synthetic Song',rect=[400,y,600,y+25],
                   enabled=True,offscreen=False,runtimeId=[i+1]) for i,y in ((0,500),(1,300))]
        tree=SimpleNamespace(prove_target=lambda row:None,desktop=SimpleNamespace(api=SimpleNamespace(
            window_rect=lambda hwnd:[0,0,1600,1000])),hwnd=1)
        observation=object.__new__(LocalObservation);observation.rows=rows;observation.tree=tree
        observation.window=[0,0,1600,1000];observation.region=[.2,.2,.8,.8]
        spec={'role':50020,'name':'Synthetic Song','region':observation.region,'selectionPolicy':'first-visible-match'}
        proof=observation.check(spec)
        self.assertEqual(proof['candidateCount'],2)
        self.assertEqual(proof['matches'][0]['index'],1)
        self.assertFalse(proof['unique']);self.assertIsNone(proof['globalUnique'])
        with self.assertRaisesRegex(ValueError,'page-match-count:2'):
            PageObservation.check(observation,spec)

    def test_declared_footer_scope_prunes_content_and_keeps_zero_wrappers(self):
        sidebar=node(box=[0,0,1600,880],children=[node('off-scope target',50020,[20,30,200,60])])
        footer=node(box=[0,880,1600,1000],children=[node('Synthetic Song',50020,[50,900,300,930])])
        fixture=RawFixture(node(children=[node(children=[sidebar,footer])]))
        rows=fixture.query([0,.88,.5,1])
        self.assertIn('Synthetic Song',[r['name'] for r in rows])
        self.assertNotIn('off-scope target',[r['name'] for r in rows])
        self.assertEqual(fixture.forbidden,0)
        self.assertGreater(fixture.tree.local_stats['prunedBranches'],0)

    def test_local_budget_refuses_instead_of_falling_back(self):
        fixture=RawFixture(node(children=[node(str(i),50020,[10,900,50,920]) for i in range(9)]))
        with self.assertRaisesRegex(uia.UiaError,'local-query-budget'):fixture.query([0,.88,.5,1],budget=8)
        self.assertEqual(fixture.tree.elements,[])
        self.assertEqual(fixture.forbidden,0)

    def test_role_projection_reads_all_children_and_keeps_ownership_and_node_budget(self):
        fixture=RawFixture(node(children=[node('Wrapper',children=[node('Song',50020,[400,350,500,380])]),
                                          node('Unused button',50000,[600,350,650,380])]))
        fixture.tree.local_projection_roles={50020}
        with patch.object(fixture.tree,'_string',wraps=fixture.tree._string) as strings:
            rows=fixture.query([.2,.2,.9,.8])
        self.assertEqual([r['name'] for r in rows],['Song'])
        self.assertEqual(fixture.tree.local_stats['visited'],3)
        self.assertTrue(all(call.args[0].node['role']==50020 for call in strings.call_args_list))
        with self.assertRaisesRegex(uia.UiaError,'local-query-budget'):
            fixture.query([.2,.2,.9,.8],budget=2)
        fixture=RawFixture(node(children=[node('foreign button',50000,[600,350,650,380],foreign=True)]))
        fixture.tree.local_projection_roles={50020}
        with self.assertRaisesRegex(uia.UiaError,'process-mismatch'):fixture.query([.2,.2,.9,.8])

    def test_depth_refuses_instead_of_claiming_incomplete_uniqueness(self):
        fixture=RawFixture(node(children=[node(children=[node(children=[node('deep',50020,[10,900,50,920])])])]))
        with self.assertRaisesRegex(uia.UiaError,'local-query-depth'):fixture.query([0,.88,.5,1],depth=2)
        self.assertEqual(fixture.tree.elements,[])

    def test_ownership_checked_before_pruning(self):
        for extra in ({'foreign':True},{'password':True}):
            fixture=RawFixture(node(children=[node(box=[0,0,100,100],**extra)]))
            with self.assertRaises(uia.UiaError):fixture.query([0,.88,.5,1])
            self.assertEqual(fixture.tree.elements,[])

    def test_saved_identity_path_looks_ahead_through_ambiguous_ancestors(self):
        target=node('Synthetic',50020,[30,30,90,50])
        fixture=RawFixture(node(children=[node(children=[node('Other',50020,[200,30,250,50])]),node(children=[target])]))
        path=[{'role':50026,'autoId':'','className':'','rect':[0,0,0,0]},
              {'role':50020,'autoId':'','className':'','rect':[30,30,90,50]}]
        with patch.object(uia,'Com',lambda p:fixture.registry[p.value]):
            rows=fixture.tree.rebind_paths([path])
        self.assertEqual([row['name'] for row in rows],['Synthetic'])
        self.assertEqual(fixture.forbidden,0)

    def test_saved_path_does_not_choose_first_duplicate_or_fall_back_when_missing(self):
        path=[[{'role':50020,'autoId':'','className':'','rect':[30,30,90,50]}]]
        fixture=RawFixture(node(children=[node('Twin',50020,[30,30,90,50]),node('Twin',50020,[30,30,90,50])]))
        with patch.object(uia,'Com',lambda p:fixture.registry[p.value]):
            self.assertEqual(len(fixture.tree.rebind_paths(path)),2)
        fixture=RawFixture(node(children=[node('Moved',50020,[300,30,390,50])]))
        with patch.object(uia,'Com',lambda p:fixture.registry[p.value]):
            self.assertEqual(fixture.tree.rebind_paths(path),[])
        self.assertEqual(fixture.forbidden,0)

    def test_saved_path_allows_text_reflow_but_still_returns_all_identity_candidates(self):
        path=[[{'role':50020,'autoId':'','className':'','rect':[30,30,190,50]}]]
        fixture=RawFixture(node(children=[node('Synthetic',50020,[48,30,208,50])]))
        with patch.object(uia,'Com',lambda p:fixture.registry[p.value]):
            self.assertEqual([r['name'] for r in fixture.tree.rebind_paths(path)],['Synthetic'])

    def test_native_anchor_does_not_persist_instance_automation_id_or_accept_virtual_impostor(self):
        path=[[{'role':50030,'autoId':'','className':'','rect':[0,0,1600,1000],'nativeAnchor':True}]]
        for native,count in ((456,1),(0,0)):
            fixture=RawFixture(node(children=[node('Host',50030,[0,0,1600,1000],autoId='new-instance-id',native=native)]))
            with patch.object(uia,'Com',lambda p:fixture.registry[p.value]):
                self.assertEqual(len(fixture.tree.rebind_paths(path)),count)

    def test_named_container_query_reads_changed_song_positions_without_outside_content(self):
        anchor={'role':50026,'autoId':'synthetic-results','className':'','rect':[300,200,1500,900]}
        content=node(box=[300,200,1500,900],autoId='synthetic-results',children=[
            node('Another song',50020,[800,350,1000,380]),node('Another artist',50020,[800,390,950,415])])
        fixture=RawFixture(node(children=[content,node('Outside',50020,[10,350,200,380])]))
        with patch.object(uia,'Com',lambda p:fixture.registry[p.value]):
            rows=fixture.tree.container_rows([anchor],[.2,.2,.9,.8])
        self.assertEqual({r['name'] for r in rows},{'Another song','Another artist'})
        self.assertEqual(fixture.tree.local_stats['containerId'],'synthetic-results')
        self.assertEqual(fixture.forbidden,0)

    def test_container_ambiguity_and_shared_budget_refuse_before_claiming_completeness(self):
        anchor={'role':50026,'autoId':'synthetic-results','className':'','rect':[300,200,1500,900]}
        fixture=RawFixture(node(children=[node(box=anchor['rect'],autoId='synthetic-results') for _ in range(2)]))
        with patch.object(uia,'Com',lambda p:fixture.registry[p.value]):
            with self.assertRaisesRegex(uia.UiaError,'container-not-unique'):
                fixture.tree.container_rows([anchor],[.2,.2,.9,.8])
        fixture=RawFixture(node(children=[node(box=anchor['rect'],autoId='synthetic-results',children=[
            node(str(i),50020,[400,350,500,380]) for i in range(8)])]))
        with patch.object(uia,'Com',lambda p:fixture.registry[p.value]):
            with self.assertRaisesRegex(uia.UiaError,'local-query-budget'):
                fixture.tree.container_rows([anchor],[.2,.2,.9,.8],budget=8)
        self.assertEqual(fixture.tree.elements,[])

    def test_bound_container_keeps_address_but_reads_new_children_and_refuses_stale_identity(self):
        anchor={'role':50026,'autoId':'synthetic-results','className':'','rect':[300,200,1500,900]}
        content=node(box=anchor['rect'],autoId='synthetic-results',children=[node('Old',50020,[400,350,500,380])])
        fixture=RawFixture(node(children=[content]));proofs=[]
        fixture.tree.prove_container=lambda r:proofs.append(r['runtimeId'])
        with patch.object(uia,'Com',lambda p:fixture.registry[p.value]):
            fixture.tree.container_rows([anchor],[.2,.2,.9,.8])
            fixture.tree.retain_local_container()
            self.assertEqual(len(fixture.tree.elements),1)
            content['children'][0]['name']='New'
            rows=fixture.tree.container_rows([anchor],[.2,.2,.9,.8])
            self.assertEqual([r['name'] for r in rows],['New'])
            self.assertEqual(len(proofs),1)
            self.assertTrue(fixture.tree.local_stats['reusedContainer'])
            fixture.tree.prove_container=lambda r:(_ for _ in ()).throw(uia.UiaError('uia-target-identity-changed'))
            with self.assertRaisesRegex(uia.UiaError,'identity-changed'):
                fixture.tree.container_rows([anchor],[.2,.2,.9,.8])
        self.assertEqual(fixture.forbidden,0)


class LocalExecutorTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.ReplayTests();self.f.setUp();self.addCleanup(self.f.doCleanups);self.f.learn()
        self.f.run_action('reset')
        data=json.loads(self.f.learned_path.read_text(encoding='utf-8'))
        data['localReplay']=copy.deepcopy(PROFILE)
        data['replayPolicy'].update(binding='local-probe-once-per-predicate-and-instance',onStaleTarget='require-learning')
        for target in data['targets'].values():target['probeRegion']=[.2,0,.6,.15]
        data['operations'].append({'id':'synthetic.inspect','title':'Inspect','description':'Synthetic',
            'inputs':[],'steps':[{'op':'observe_local'},{'op':'assert_rows','match':{
                'role':50004,'anyName':True,'region':[.2,0,.6,.15]}}]})
        self.data=data
        self.write()
        self.f.desktop.api.capture_dpi=lambda:None
        self.f.desktop.api.window_rect=lambda hwnd:[0,0,1600,1000]
        f=self.f.f;owner=self
        parent=self.f.tree_factory
        class Tree(parent):
            def __init__(_self,*args):
                super().__init__(*args);_self.elements=[{'role':'Edit'},{'role':'Button'}]
            def local_rows(_self,region,budget,depth):
                f.local_calls+=1;_self.guard()
                return [dict(index=i,role=role,roleName=role_name,name=f.value if i==0 else f.button_name,
                    autoId='',className='',runtimeId=None,native=0,enabled=True,offscreen=False,rect=box)
                    for i,role,role_name,box in [(0,50004,'Edit',[420,30,800,80]),(1,50000,'Button',[440,40,470,70])]]
            def enumerate(_self,*args,**kwargs):raise AssertionError('whole-tree query forbidden')
            def _string(_self,element,slot):
                _self.guard();return f.value if element['role']=='Edit' else f.button_name
            def runtime_id(_self,element):return [7,1 if element['role']=='Edit' else 2]
            def prove_target(_self,row):
                _self.guard()
                if f.stale:raise uia.UiaError('uia-target-identity-changed')
                return {'identityRebound':True}
        f.local_calls=0;self.f.runner.tree_factory=Tree

    def write(self):
        for path in (self.f.template_path,self.f.learned_path):
            path.write_text(json.dumps(self.data),encoding='utf-8')

    def test_layout_is_learned_configuration_and_limits_are_not_task_parameters(self):
        data=copy.deepcopy(self.data)
        data['environment']['size']={'width':1280,'height':800}
        data['localReplay']['layout']=dict(data['environment']['size'])
        self.assertEqual(validate_local_profile(data)['layout'],{'width':1280,'height':800})
        data['localReplay']['layout']['width']=1281
        with self.assertRaises(RelearnRequired):validate_local_profile(data)
        data['localReplay']['layout']=dict(data['environment']['size'])
        for key in ('maxNodes','maxDepth','maxCachedQueries','maxRetainedElements'):
            bad=copy.deepcopy(data);bad['localReplay'][key]+=1
            with self.subTest(key=key),self.assertRaises(RelearnRequired):validate_local_profile(bad)
        for size in ({'width':2049,'height':800},{'width':1280,'height':299},
                     {'width':True,'height':800},{'width':1280,'height':800,'extra':1}):
            bad=copy.deepcopy(data);bad['localReplay']['layout']=size;bad['environment']['size']=size
            with self.subTest(size=size),self.assertRaises(RelearnRequired):validate_local_profile(bad)

    def test_local_bind_then_live_input_and_inspection_reuse_without_any_full_query(self):
        before=self.f.f.full
        bound=self.f.run_action('synthetic.locateSearch')
        self.assertEqual(bound['status'],'done',bound)
        self.assertEqual(bound['output']['fullQueries'],0)
        self.assertEqual(self.f.f.local_calls,2)
        fill=self.f.run_action('synthetic.fillSearch',{'query':'New synthetic value'})
        self.assertEqual(fill['status'],'done',fill)
        inspected=self.f.run_action('synthetic.inspect')
        self.assertEqual(inspected['status'],'done',inspected)
        self.assertEqual(inspected['output']['reusedReads'],1)
        self.assertEqual(inspected['output']['fullQueries'],0)
        self.assertEqual(self.f.f.local_calls,2)
        self.assertEqual(self.f.f.full,before)
        proof=inspected['output']['checks'][0]
        self.assertIsNone(proof['globalUnique'])
        self.assertEqual(proof['scope'],'learned-local-region')

    def test_stale_bound_target_stops_and_does_not_requery(self):
        self.f.run_action('synthetic.locateSearch');self.f.f.stale=True
        job=self.f.run_action('synthetic.inspect')
        self.assertEqual(job['status'],'failed')
        self.assertIn('需要重新学习',job['verification']['evidence'])
        self.assertEqual(self.f.f.local_calls,2)
        self.assertEqual(self.f.f.actions,0)

    def test_missing_local_parameters_stops_before_effect(self):
        del self.data['targets']['search']['probeRegion'];self.write()
        job=self.f.run_action('synthetic.locateSearch')
        self.assertEqual(job['status'],'failed')
        self.assertIn('需要重新学习',job['verification']['evidence'])
        self.assertEqual(self.f.f.local_calls,0)
        self.assertEqual(self.f.f.actions,0)

    def test_wrong_physical_layout_refuses_before_query(self):
        self.f.desktop.api.window_rect=lambda hwnd:[0,0,1601,1128]
        job=self.f.run_action('synthetic.locateSearch')
        self.assertIn('window-layout-mismatch',job['error'])
        self.assertEqual(self.f.f.local_calls,0)

    def test_local_target_must_still_match_saved_learning_identity(self):
        self.data['learning']['targets']['search']['autoId']='synthetic-required-id';self.write()
        job=self.f.run_action('synthetic.locateSearch')
        self.assertEqual(job['status'],'failed',job)
        self.assertIn('需要重新学习',job['verification']['evidence'])
        self.assertIn('learned-target-parameters-changed:search',job['error'])
        self.assertEqual(self.f.f.actions,0)

    def test_reset_closes_shared_local_trees_once_on_the_actor_thread(self):
        self.f.run_action('synthetic.locateSearch');start=len(self.f.f.closed)
        job=self.f.run_action('reset')
        self.assertEqual(job['status'],'done',job)
        released=self.f.f.closed[start:]
        self.assertEqual(len(released),2)
        self.assertEqual(len(set(released)),2)
        self.assertIsNone(self.f.runner.local_bindings)

    def test_duplicate_local_target_refuses_and_does_not_dispatch(self):
        parent=self.f.runner.tree_factory
        class Duplicate(parent):
            def local_rows(_self,*args):
                rows=super().local_rows(*args);rows.append({**rows[0],'index':1});return rows
        self.f.runner.tree_factory=Duplicate
        job=self.f.run_action('synthetic.locateSearch')
        self.assertEqual(job['status'],'failed')
        self.assertIn('page-match-count:2',job['error'])
        self.assertEqual(self.f.f.actions,0)

    def test_saved_paths_rebind_in_fresh_tree_without_local_discovery(self):
        parent=self.f.runner.tree_factory;f=self.f.f;f.path_calls=0
        class PathTree(parent):
            def export_path(_self,row):
                return [{'role':row['role'],'autoId':'','className':'','rect':row['rect']}]
            def rebind_paths(_self,paths,budget,depth):
                f.path_calls+=1
                before=f.local_calls
                rows=super().local_rows([.2,0,.6,.1],budget,depth)
                f.local_calls=before
                return rows
        runner=self.f.runner;runner.tree_factory=PathTree
        runner.paths_path=self.f.root/'paths.json';runner.job={'calls':[]};runner.learning_paths=True
        spec={'role':50004,'anyName':True,'region':[.2,0,.6,.1]}
        def learn_and_release():
            runner._local_query(self.data,spec)
            runner.path_store.save();runner._drop()
        runner.executor.submit(learn_and_release).result(timeout=5)
        self.assertEqual(f.local_calls,1)
        runner.learning_paths=False;runner.paths_contract_checked=False
        _tree,proof=runner.executor.submit(runner._local_query,self.data,spec).result(timeout=5)
        self.assertEqual(f.local_calls,1)
        self.assertEqual(f.path_calls,1)
        self.assertEqual(proof['scope'],'learned-target-identity-path')
        self.assertIsNone(proof['globalUnique'])
        self.assertEqual(f.actions,0)

    def test_changing_runtime_song_reuses_one_saved_container_template_without_learning(self):
        from learned_paths import LearnedPaths
        runner=self.f.runner;parent=runner.tree_factory;f=self.f.f;f.container_calls=0
        class ContainerTree(parent):
            def container_rows(_self,path,region,budget,depth):
                f.container_calls+=1
                before=f.local_calls
                rows=super().local_rows(region,budget,depth)
                f.local_calls=before
                return rows
            def rebind_paths(_self,*args):raise AssertionError('song-specific leaf path forbidden')
        runner.tree_factory=ContainerTree;runner.paths_path=self.f.root/'generic-paths.json'
        template={'role':50004,'name':'${song}','region':[.2,0,.6,.1]}
        store=LearnedPaths(runner.paths_path);store.begin(runner.fingerprint(self.data['application']['executable']),PROFILE,True)
        store.record(template,[[{'role':50026,'autoId':'synthetic-container','className':'','rect':[300,0,900,100]},
                               {'role':50004,'autoId':'','className':'','rect':[420,30,800,80]}]])
        store.save();before=runner.paths_path.read_bytes()
        for song in ('First synthetic song','Second synthetic song'):
            f.value=song
            _tree,proof=runner.executor.submit(runner._local_query,self.data,{**template,'name':song},template=template).result(timeout=5)
            self.assertEqual(proof['count'],1)
            self.assertEqual(proof['scope'],'learned-container-visible-region')
        self.assertEqual(f.container_calls,2)
        self.assertEqual(f.local_calls,0)
        self.assertEqual(runner.paths_path.read_bytes(),before)
        f.value='Different name'
        with self.assertRaises(TargetQueryError):
            runner.executor.submit(runner._local_query,self.data,{**template,'name':'Missing synthetic song'},template=template).result(timeout=5)
        self.assertEqual(f.actions,0)

    def test_latest_job_is_read_only_and_available_after_page_reload(self):
        job=self.f.run_action('synthetic.inspect')
        self.assertEqual(self.f.runner.status('latest'),job)
        self.assertEqual(self.f.f.actions,0)

    def test_startup_waits_for_render_and_stable_geometry_before_single_fit(self):
        from hidden_desktop import Blocked
        clock=[0.0];samples=[0];fits=[];rect=[0,0,1601,1128]
        def capture(hwnd):
            samples[0]+=1
            if samples[0]==1:raise Blocked('preview_unrendered')
            return {'unrendered':False},b'synthetic'
        def fit(name,args):
            fits.append((name,args));rect[:]=[0,0,1600,1000];return {}
        runner=self.f.runner;runner.job={'calls':[]}
        self.f.desktop.capture_frame=capture
        self.f.desktop.api.window_rect=lambda hwnd:list(rect)
        base=copy.deepcopy(self.data);base.pop('localReplay')
        with patch('learned_replay.time.monotonic',lambda:clock[0]), \
                patch('learned_replay.time.sleep',lambda seconds:clock.__setitem__(0,clock[0]+seconds)), \
                patch.object(runner,'invoke',fit):
            runner._prepare_local_window(self.data,base)
        self.assertEqual(len(fits),1)
        self.assertEqual(fits[0][0],'act.window.fit')
        self.assertGreaterEqual(clock[0],1.2)
        self.assertEqual(self.f.f.local_calls,0)
        self.assertEqual(self.f.f.actions,0)

    def test_startup_unrendered_surface_times_out_without_fitting_or_input(self):
        from hidden_desktop import Blocked
        clock=[0.0];runner=self.f.runner;runner.job={'calls':[]}
        self.f.desktop.capture_frame=lambda hwnd:(_ for _ in ()).throw(Blocked('preview_unrendered'))
        base=copy.deepcopy(self.data);base.pop('localReplay')
        with patch('learned_replay.time.monotonic',lambda:clock[0]), \
                patch('learned_replay.time.sleep',lambda seconds:clock.__setitem__(0,clock[0]+seconds)), \
                patch.object(runner,'invoke') as invoke:
            with self.assertRaisesRegex(Exception,'startup-window-not-stable'):
                runner._prepare_local_window(self.data,base)
        invoke.assert_not_called()

    def test_declared_page_ready_wait_only_re_reads_initial_absence(self):
        runner=self.f.runner;runner.job={'calls':[]};clock=[0.0]
        operation={'steps':[{'op':'observe_local','readyMatch':{'role':50004,'anyName':True,'region':[.2,0,.6,.1]},'timeoutMs':2000}]}
        with patch.object(runner,'_traced_local_query',side_effect=[RelearnRequired('page-match-count:0:expected-1..1'),(None,{})]) as query, \
                patch('learned_replay.time.monotonic',lambda:clock[0]), \
                patch('learned_replay.time.sleep',lambda seconds:clock.__setitem__(0,clock[0]+seconds)):
            runner._local_operation(self.data,operation)
        self.assertEqual(query.call_count,2)
        self.assertEqual(self.f.f.actions,0)
        with patch.object(runner,'_traced_local_query',side_effect=RelearnRequired('page-match-count:2:expected-1..1')) as query:
            with self.assertRaises(RelearnRequired):runner._local_operation(self.data,operation)
        self.assertEqual(query.call_count,1)

    def test_ready_proof_consumed_only_by_immediate_identical_assertion(self):
        runner=self.f.runner;match={'role':50004,'anyName':True,'region':[.2,0,.6,.1]}
        proof={'matches':[],'reusedBinding':False,'localStatistics':{'visited':5}}
        operation={'steps':[{'op':'observe_local','readyMatch':match,'timeoutMs':2000},
                            {'op':'assert_rows','match':match}]}
        runner.job={'calls':[]}
        with patch.object(runner,'_traced_local_query',return_value=(None,proof)) as query:
            runner._local_operation(self.data,operation)
        self.assertEqual(query.call_count,1)
        self.assertEqual(runner.job['calls'][-1]['capability'],'replay.local.consume_ready')
        operation['steps'].insert(1,{'op':'wait','milliseconds':0})
        with patch.object(runner,'_traced_local_query',return_value=(None,proof)) as query:
            runner._local_operation(self.data,operation)
        self.assertEqual(query.call_count,2)

    def test_joint_player_ready_proof_is_consumed_by_one_click_without_a_second_query(self):
        runner=self.f.runner
        match={'role':50006,'name':'','region':[0,.88,.1,1],'queryRegion':[0,.88,.5,1],
               'nearAll':[{'role':50020,'name':'Artist','dx':[40,700],'dy':[-40,100]},
                          {'role':50020,'name':'Song','dx':[40,700],'dy':[-80,60]}]}
        proof={'matches':[{'native':0,'rect':[40,900,120,980]}],
               'reusedBinding':False,'identityProofCount':3,'localStatistics':{'visited':8}}
        operation={'steps':[{'op':'observe_local','readyMatch':match,'timeoutMs':2000},
                            {'op':'click_match','match':match}]}
        runner.job={'calls':[]}
        with patch.object(runner,'_traced_local_query',return_value=(None,proof)) as query, \
                patch.object(self.f.desktop,'click',return_value={'dispatched':True}) as click:
            runner._local_operation(self.data,operation)
        self.assertEqual(query.call_count,1)
        click.assert_called_once()
        consumed=next(c for c in runner.job['calls'] if c['capability']=='replay.local.consume_ready')
        self.assertTrue(consumed['result']['observationReused'])
        self.assertEqual(consumed['result']['identityProofCount'],3)

    def test_ready_wait_deadline_and_identity_failure_never_dispatch_or_retry_input(self):
        runner=self.f.runner;runner.job={'calls':[]};clock=[0.0]
        operation={'steps':[{'op':'observe_local','readyMatch':{'role':50004,'anyName':True,
                            'region':[.2,0,.6,.1]},'timeoutMs':100}]}
        with patch.object(runner,'_traced_local_query',side_effect=RelearnRequired('page-match-count:0:expected-1..1')), \
                patch('learned_replay.time.monotonic',lambda:clock[0]), \
                patch('learned_replay.time.sleep',lambda s:clock.__setitem__(0,clock[0]+s)):
            with self.assertRaises(RelearnRequired):runner._local_operation(self.data,operation)
        with patch.object(runner,'_traced_local_query',side_effect=RelearnRequired('uia-target-identity-changed')) as query:
            with self.assertRaises(RelearnRequired):runner._local_operation(self.data,operation)
        self.assertEqual(query.call_count,1)
        self.assertEqual(self.f.f.actions,0)

    def test_warm_binding_proves_selected_identity_once_without_discovery(self):
        runner=self.f.runner;match={'role':50004,'anyName':True,'region':[.2,0,.6,.1]}
        def check():
            tree,_proof=runner._local_query(self.data,match)
            with patch.object(tree,'prove_target',wraps=tree.prove_target) as prove:
                _tree,proof=runner._local_query(self.data,match)
                self.assertEqual(prove.call_count,1)
                self.assertTrue(proof['reusedBinding'])
        runner.executor.submit(check).result(timeout=5)

    def test_reused_rendered_window_checks_identity_and_geometry_without_fit_or_sleep(self):
        runner=self.f.runner;runner.job={'calls':[]};desktop=self.f.desktop
        desktop.capture_frame=lambda hwnd:({'unrendered':False},b'synthetic')
        with patch.object(runner,'_environment',return_value=(desktop,1,{},{})), \
                patch.object(runner,'invoke') as invoke,patch('learned_replay.time.sleep') as sleep:
            runner._prepare_local_window(self.data,self.data,reuse=True)
        invoke.assert_not_called();sleep.assert_not_called()
        self.assertEqual(runner.job['calls'][-1]['capability'],'replay.window.reuse_layout')

    def test_persisted_job_restores_only_record_and_never_binding_or_effect(self):
        path=self.f.root/'latest-run.json'
        self.f.runner.job_path=path
        job=self.f.run_action('synthetic.inspect')
        self.assertEqual(json.loads(path.read_text(encoding='utf-8')),job)
        runner=self.f.make_runner()
        restored=type(runner)(self.f.lab,runner.host_lock,self.f.template_path,self.f.learned_path,
            lambda info:None,tree_factory=runner.tree_factory,fingerprint_fn=runner.fingerprint,job_path=path)
        self.addCleanup(restored.shutdown)
        self.assertEqual(restored.status('latest'),job)
        self.assertFalse(restored.busy())
        self.assertIsNone(restored.local_bindings)
        self.assertEqual(restored.bound,{})
        self.assertEqual(restored.values,{})
        self.assertEqual(self.f.f.actions,0)

    def test_version_and_instance_changes_prompt_relearning_without_requery(self):
        for mode in ('version','instance'):
            self.f.run_action('reset')
            self.f.run_action('synthetic.locateSearch')
            before=self.f.f.local_calls
            if mode=='version':self.f.f.fp='b'*64
            else:self.f.f.instance+='-changed'
            job=self.f.run_action('synthetic.inspect')
            self.assertEqual(job['status'],'failed',job)
            self.assertIn('需要重新学习',job['verification']['evidence'])
            self.assertEqual(self.f.f.local_calls,before)
            self.assertEqual(self.f.f.actions,0)
            self.f.f.fp='a'*64


if __name__=='__main__':unittest.main()
