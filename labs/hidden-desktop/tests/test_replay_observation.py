"""合成观察验证，不导入真实应用快照。"""
import copy
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from replay_observation import PageObservation, matches, validate_match


def row(index, name, rect, role=50020):
    return dict(index=index, name=name, role=role, rect=rect, enabled=True, offscreen=False, runtimeId=[index+1])


class ObservationTests(unittest.TestCase):
    def setUp(self):
        self.rows = [row(0, 'Synthetic Song', [200, 200, 400, 230]),
                     row(1, 'Synthetic Artist', [210, 240, 300, 260]),
                     row(2, 'Synthetic Song', [100, 900, 300, 930])]
        self.spec = dict(role=50020, name='Synthetic Song', region=[.15,.1,.6,.8],
                         near=dict(role=50020, name='Synthetic Artist', dx=[0,100], dy=[20,80]))

    def tree(self, truncated=False, mutate=None):
        def prove(r):
            if mutate: mutate(r)
        return SimpleNamespace(enumerate=lambda *a, **kw: copy.deepcopy(self.rows),
            truncated=truncated, prove_target=prove, hwnd=7,
            desktop=SimpleNamespace(api=SimpleNamespace(window_rect=lambda h: [0,0,1000,1000])))

    def test_title_and_artist_relation_excludes_footer_and_wrong_artist(self):
        self.assertEqual(len(matches(self.rows,self.spec,[0,0,1000,1000])),1)
        self.rows[1]['name']='Other Artist'
        self.assertEqual(matches(self.rows,self.spec,[0,0,1000,1000]),[])

    def test_explicit_alias_verifies_actual_identity_without_changing_other_names(self):
        self.rows[1]['name']='Canonical Artist'
        spec=copy.deepcopy(self.spec)
        spec['near']['nameAliases']={'Synthetic Artist':['Canonical Artist']}
        validate_match(spec)
        proved=[]
        tree=self.tree();tree.prove_target=lambda r:proved.append((r['index'],r['name']))
        proof=PageObservation(tree,{}).check(spec)
        self.assertEqual(proof['identityProofCount'],2)
        self.assertIn((1,'Canonical Artist'),proved)
        self.rows[1]['name']='Canonical Artist tribute'
        self.assertFalse(matches(self.rows,spec,[0,0,1000,1000]))
        self.rows[1]['name']='Canonical Artist';spec['near']['name']='Other Artist'
        self.assertFalse(matches(self.rows,spec,[0,0,1000,1000]))

    def test_alias_does_not_suppress_duplicate_artist_or_missing_live_identity(self):
        self.rows[1]['name']='Canonical Artist'
        spec=copy.deepcopy(self.spec)
        spec['near']['nameAliases']={'Synthetic Artist':['Canonical Artist']}
        self.rows.append(row(3,'Synthetic Artist',[210,240,300,260]))
        with self.assertRaisesRegex(ValueError,'page-match-count:0'):
            PageObservation(self.tree(),{}).check(spec)
        self.rows.pop()
        tree=self.tree()
        tree.prove_target=lambda r:(_ for _ in ()).throw(ValueError('identity-changed'))
        with self.assertRaisesRegex(ValueError,'identity-changed'):
            PageObservation(tree,{}).check(spec)

    def test_undeclared_alias_and_alias_chaining_are_not_accepted(self):
        self.rows[1]['name']='Canonical Artist'
        self.assertFalse(matches(self.rows,self.spec,[0,0,1000,1000]))
        spec=copy.deepcopy(self.spec)
        spec['near']['nameAliases']={'Synthetic Artist':['Intermediate Artist'],
                                     'Intermediate Artist':['Canonical Artist']}
        self.assertFalse(matches(self.rows,spec,[0,0,1000,1000]))

    def test_invalid_alias_configurations_are_rejected(self):
        invalid=[[],{}, {'x':'y'}, {'x':[]}, {'x':['y','y']}, {'x':[None]},
                 {'x':['y']*9}, {'x':['z'*513]}, {str(i):['alias'] for i in range(9)}]
        for aliases in invalid:
            with self.subTest(aliases=aliases),self.assertRaisesRegex(ValueError,'invalid-page-name-aliases'):
                validate_match({'role':50020,'name':'x','nameAliases':aliases})
        with self.assertRaisesRegex(ValueError,'invalid-page-name-aliases'):
            validate_match({'role':50020,'anyName':True,'nameAliases':{'x':['y']}})

    def test_joint_proof_reads_each_identity_once_and_returns_verified_peers(self):
        proved=[];tree=self.tree();tree.prove_target=lambda r:proved.append(r['index'])
        proof=PageObservation(tree,{}).check(self.spec)
        self.assertEqual(proved,[0,1])
        self.assertEqual(proof['identityProofCount'],2)
        self.assertEqual([r['index'] for r in proof['relatedMatches']],[1])

    def test_joint_song_artist_and_playback_requires_all_three(self):
        self.rows.append(row(3,'pause',[700,210,750,250],role=50000))
        spec=copy.deepcopy(self.spec);artist=spec.pop('near')
        spec['nearAll']=[artist,dict(role=50000,name='pause',dx=[450,550],dy=[0,30])]
        proof=PageObservation(self.tree(),{}).check(spec)
        self.assertEqual(proof['identityProofCount'],3)
        self.rows[-1]['name']='play'
        with self.assertRaisesRegex(ValueError,'page-match-count:0'):
            PageObservation(self.tree(),{}).check(spec)

    def test_playing_title_can_scroll_without_using_old_geometry_as_evidence(self):
        spec=copy.deepcopy(self.spec);spec['region']=[0,.1,.6,.8]
        spec['near']['dx']=[-600,600]
        def scroll(r):
            if r['index']==0:r['rect']=[80,200,280,230]
        proof=PageObservation(self.tree(mutate=scroll),{}).check(spec)
        self.assertEqual(proof['matches'][0]['rect'],[80,200,280,230])
        self.rows[1]['name']='Wrong Artist'
        with self.assertRaisesRegex(ValueError,'page-match-count:0'):
            PageObservation(self.tree(mutate=scroll),{}).check(spec)

    def test_stable_artist_anchor_verifies_both_marquee_copies_with_declared_bound(self):
        self.rows=[row(0,'Artist',[200,240,280,270]),row(1,'Song',[100,200,250,230]),
                   row(2,'Song',[400,200,550,230])]
        spec=dict(role=50020,name='Artist',region=[0,.1,.8,.8],
                  near=dict(role=50020,name='Song',dx=[-600,600],dy=[-80,-20],min=1,max=2))
        proof=PageObservation(self.tree(),{}).check(spec)
        self.assertEqual(proof['identityProofCount'],3)
        self.assertEqual(len(proof['relatedMatches']),2)
        self.rows.append(row(3,'Song',[600,200,750,230]))
        with self.assertRaisesRegex(ValueError,'page-match-count:0'):
            PageObservation(self.tree(),{}).check(spec)

    def test_joint_cover_anchor_allows_marquee_to_move_left_but_requires_artist_and_title(self):
        self.rows=[row(0,'',[20,900,90,980],role=50006),
                   row(1,'Artist',[140,950,240,975]),row(2,'Song',[140,910,350,940])]
        spec=dict(role=50006,name='',region=[0,.88,.1,1],nearAll=[
            dict(role=50020,name='Artist',region=[0,.88,.5,1],dx=[40,700],dy=[-40,100]),
            dict(role=50020,name='Song',region=[0,.88,.5,1],dx=[-800,800],dy=[-80,60],min=1,max=2)])
        def scroll(r):
            if r['index']==2:r['rect']=[20,910,230,940]
        proof=PageObservation(self.tree(mutate=scroll),{}).check(spec)
        self.assertEqual(proof['identityProofCount'],3)
        self.rows[1]['name']='Wrong Artist'
        with self.assertRaisesRegex(ValueError,'page-match-count:0'):
            PageObservation(self.tree(),{}).check(spec)

    def test_duplicate_candidates_refused_instead_of_first(self):
        self.rows.append(row(3,'Synthetic Song',[200,201,400,231]))
        with self.assertRaisesRegex(ValueError,'page-match-count:2'):
            PageObservation(self.tree(),{}).check(self.spec)

    def test_incomplete_query_refused(self):
        with self.assertRaisesRegex(ValueError,'page-query-incomplete'):
            PageObservation(self.tree(True),{})

    def test_optional_control_absence_requires_complete_query_and_duplicates_refuse(self):
        absent=PageObservation(self.tree(),{}).check({'role':50000,'name':'Synthetic optional'},0,1)
        self.assertEqual(absent['count'],0)
        self.assertTrue(absent['complete'])
        with self.assertRaisesRegex(ValueError,'page-match-count:2'):
            PageObservation(self.tree(),{}).check({'role':50020,'name':'Synthetic Song'},0,1)

    def test_selected_target_missing_identity_is_not_ignored(self):
        self.rows[0]['runtimeId']=None
        tree=self.tree()
        tree.elements=[object()]*3
        def missing(element):raise ValueError('synthetic-target-identity-unavailable')
        tree.runtime_id=missing
        with self.assertRaisesRegex(ValueError,'synthetic-target-identity-unavailable'):
            PageObservation(tree,{}).check(self.spec)

    def test_geometry_change_during_live_proof_refused(self):
        def move(r): r['rect']=[700,700,900,730]
        with self.assertRaisesRegex(ValueError,'page-match-changed'):
            PageObservation(self.tree(mutate=move),{}).check(self.spec)

    def test_related_artist_moves_during_proof_is_refused(self):
        def move(r):
            if r['index']==1:r['rect']=[700,700,800,730]
        with self.assertRaisesRegex(ValueError,'page-relation-changed'):
            PageObservation(self.tree(mutate=move),{}).check(self.spec)

    def test_hidden_and_outside_targets_refused(self):
        for field,value in [('offscreen',True),('rect',[-10,10,10,30])]:
            data=copy.deepcopy(self.rows);data[0][field]=value
            self.assertFalse(matches(data,self.spec,[0,0,1000,1000]))

    def test_invalid_regions_and_recursive_relations_refused(self):
        for region in ([1,0,0,1], [0,0,2,1], [0,0,float('nan'),1]):
            with self.assertRaises(ValueError):validate_match(dict(role=50020,name='x',region=region))

    def test_album_disambiguates_same_title_artist_without_row_order(self):
        self.rows=[row(0,'Synthetic Song',[100,200,200,230]),row(1,'Artist',[400,200,500,230]),
                   row(2,'Studio',[700,200,800,230]),row(3,'Synthetic Song',[100,300,200,330]),
                   row(4,'Artist',[400,300,500,330]),row(5,'Live',[700,300,800,330])]
        spec=dict(role=50020,name='Synthetic Song',region=[0,.1,.3,.8],queryRegion=[0,.1,1,.8],
                  nearAll=[dict(role=50020,name='Artist',dx=[250,350],dy=[-5,5]),
                           dict(role=50020,name='Studio',dx=[550,650],dy=[-5,5],optionalIfEmpty=True)])
        validate_match(spec)
        self.assertEqual([r['index'] for r in matches(list(reversed(self.rows)),spec,[0,0,1000,1000])],[0])
        spec['nearAll'][1]['name']=''
        with self.assertRaisesRegex(ValueError,'page-match-count:2'):
            PageObservation(self.tree(),{}).check(spec)
        spec['nearAll'][1]['name']='Absent'
        self.assertFalse(matches(self.rows,spec,[0,0,1000,1000]))
        spec['nearAll'][1]['name']='Studio';self.rows[1]['name']='Wrong Artist'
        self.assertFalse(matches(self.rows,spec,[0,0,1000,1000]))


if __name__=='__main__':unittest.main()
