"""纯合成的 JSON 路径存储检查，不打开真实应用。"""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from learned_paths import LearnedPaths
from local_replay import RelearnRequired


class PathStoreTests(unittest.TestCase):
    def setUp(self):
        root=Path(__file__).resolve().parents[1]/'reports'/'synthetic-tests';root.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=root);self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)/'synthetic.json'
        self.fp={'sha256':'a'*64};self.profile={'layout':{'width':1600,'height':1000}}
        self.match={'role':50004,'anyName':True,'region':[.2,0,.6,.1]}
        self.paths=[[{'role':50004,'autoId':'synthetic','className':'','rect':[400,20,600,60]}]]

    def test_only_explicit_success_save_persists_plain_paths(self):
        store=LearnedPaths(self.path);store.begin(self.fp,self.profile,True)
        store.record(self.match,self.paths)
        self.assertFalse(self.path.exists())
        store.save()
        restored=LearnedPaths(self.path);restored.begin(self.fp,self.profile)
        self.assertEqual(restored.get(self.match),self.paths)
        saved=self.path.read_text(encoding='utf-8')
        for forbidden in ('runtimeId','hwnd','pid','COM'):self.assertNotIn(forbidden,saved)

    def test_missing_parameters_and_changed_contract_require_learning(self):
        store=LearnedPaths(self.path)
        with self.assertRaises(RelearnRequired):store.begin(self.fp,self.profile)
        store.begin(self.fp,self.profile,True)
        with self.assertRaises(RelearnRequired):store.get(self.match)
        store.record(self.match,self.paths);store.save()
        with self.assertRaises(RelearnRequired):store.begin({'sha256':'b'*64},self.profile)

    def test_corrupt_file_refuses_instead_of_overwriting_or_falling_back(self):
        self.path.write_text('{bad',encoding='utf-8')
        with self.assertRaises(RelearnRequired):LearnedPaths(self.path)
        self.assertEqual(self.path.read_text(encoding='utf-8'),'{bad')

    def test_explicit_relearning_can_repair_corrupt_file_only_after_success_save(self):
        self.path.write_text('{bad',encoding='utf-8')
        store=LearnedPaths(self.path,learning=True);store.begin(self.fp,self.profile,True)
        store.record(self.match,self.paths)
        self.assertEqual(self.path.read_text(encoding='utf-8'),'{bad')
        store.save()
        restored=LearnedPaths(self.path);restored.begin(self.fp,self.profile)
        self.assertEqual(restored.get(self.match),self.paths)

    def test_parameterized_matches_share_named_container_without_song_leaf_geometry(self):
        store=LearnedPaths(self.path);store.begin(self.fp,self.profile,True)
        anchor={'role':50026,'autoId':'synthetic-results','className':'','rect':[300,200,1500,3000]}
        template={'role':50020,'name':'${song}','region':[.2,.2,.9,.8]}
        paths=[[anchor,{'role':50020,'autoId':'','className':'','rect':[400,350,700,380]}]]
        store.record(template,paths)
        store.record({**template,'name':'${artist}'},paths)
        store.save()
        restored=LearnedPaths(self.path);restored.begin(self.fp,self.profile)
        binding=restored.get(template)
        self.assertEqual(binding['mode'],'container')
        self.assertEqual(binding['containerPath'],[{**anchor,'rect':[300,200,1500,1000]}])
        self.assertEqual(len(restored.data['containers']),1)
        self.assertIn('${song}',self.path.read_text(encoding='utf-8'))
        self.assertNotIn('350',self.path.read_text(encoding='utf-8'))

    def test_parameterized_learning_refuses_root_only_or_unnamed_container(self):
        store=LearnedPaths(self.path);store.begin(self.fp,self.profile,True)
        with self.assertRaisesRegex(RelearnRequired,'missing-stable-local-container'):
            store.record({'role':50020,'name':'${song}'},self.paths)
        self.assertFalse(self.path.exists())

    def test_static_label_can_explicitly_bind_named_container_without_leaf_geometry(self):
        store=LearnedPaths(self.path);store.begin(self.fp,self.profile,True)
        match={'role':50020,'name':'Details','region':[.4,.1,.9,.4],'bindingScope':'container'}
        anchor={'role':50026,'autoId':'synthetic-detail','className':'','rect':[0,0,1600,1000]}
        leaf={'role':50020,'autoId':'','className':'','rect':[800,220,900,250]}
        store.record(match,[[anchor,leaf]]);store.save()
        restored=LearnedPaths(self.path);restored.begin(self.fp,self.profile)
        self.assertEqual(restored.get(match)['containerPath'],[anchor])
        self.assertNotIn('220',self.path.read_text(encoding='utf-8'))
        with self.assertRaisesRegex(RelearnRequired,'missing-stable-local-container'):
            store.record(match,[[leaf]])
        with self.assertRaisesRegex(RelearnRequired,'invalid-binding-scope'):
            store.record({**match,'bindingScope':'anything'},[[anchor,leaf]])
