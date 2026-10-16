"""实验入口配置的合成检查，不读取真实学习文件或启动应用。"""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from experiment_config import load_experiment


class ExperimentConfigTests(unittest.TestCase):
    def setUp(self):
        parent = Path(__file__).resolve().parents[1] / 'reports/synthetic-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = dict(schemaVersion=1, template='recipes/example.json', learned='learned/example.json',
                         workflow='recipes/flow.json', capabilities='learned/capabilities',
                         paths='learned/paths.json', record='reports/latest.json',
                         page=dict(route='/workflows/example', file='example.html'))

    def write(self):
        (self.root / 'experiment.json').write_text(json.dumps(self.data), encoding='utf-8')

    def test_application_specific_paths_are_configuration_not_runtime_constants(self):
        self.write()
        config = load_experiment(self.root)
        self.assertEqual(config.template, self.root / 'recipes/example.json')
        self.assertEqual(config.page_route, '/workflows/example')
        self.assertEqual(config.page_file, self.root / 'example.html')

    def test_absolute_parent_and_root_paths_are_rejected(self):
        for value in ('../outside.json', str(self.root / 'absolute.json'), '.', ''):
            with self.subTest(value=value):
                self.data['template'] = value
                self.write()
                with self.assertRaises(ValueError):load_experiment(self.root)

    def test_missing_fields_unknown_fields_and_invalid_route_are_rejected(self):
        original = copy.deepcopy(self.data)
        for change in ('missing', 'unknown', 'route', 'page-file'):
            self.data = copy.deepcopy(original)
            if change == 'missing':del self.data['workflow']
            elif change == 'unknown':self.data['execute'] = 'code'
            elif change == 'page-file':self.data['page']['file'] = '../outside.html'
            else:self.data['page']['route'] = '/api/state'
            self.write()
            with self.subTest(change=change), self.assertRaises(ValueError):load_experiment(self.root)

    def test_missing_invalid_and_oversized_manifest_fail_closed(self):
        with self.assertRaises(ValueError):load_experiment(self.root)
        path = self.root / 'experiment.json'
        for content in ('[]', '{', ' ' * 16385):
            path.write_text(content, encoding='utf-8')
            with self.assertRaises(ValueError):load_experiment(self.root)

    def test_optional_manual_flow_stays_inside_lab(self):
        self.data['manualFlow']='recipes/manual.json';self.write()
        self.assertEqual(load_experiment(self.root).manual_flow,self.root/'recipes/manual.json')
        self.data['manualFlow']='../outside.json';self.write()
        with self.assertRaises(ValueError):load_experiment(self.root)


if __name__ == '__main__':unittest.main()
