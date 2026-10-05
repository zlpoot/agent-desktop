"""Pure collector contract tests; does not import Windows libraries or claim live UIA coverage."""
import ast
import pathlib
import types
import unittest

class CaptureTests(unittest.TestCase):
    def setUp(self):
        source = ast.parse(pathlib.Path('src/runtime/desktop/worker.py').read_text(encoding='utf-8'))
        functions = [n for n in source.body if isinstance(n, ast.FunctionDef) and
                     n.name in ('elements', 'find_control')]
        self.ns = {}
        exec(compile(ast.Module(body=functions, type_ignores=[]), '<collector>', 'exec'), self.ns)

    def control(self, name='name', value='value', children=None, role='Edit', accessible_name=None):
        return types.SimpleNamespace(
            descendants=lambda: children or [],
            element_info=types.SimpleNamespace(runtime_id=[1, 2], control_type=role,
                automation_id='field', class_name=role, name=accessible_name),
            rectangle=lambda: types.SimpleNamespace(left=0, top=0, width=lambda: 100, height=lambda: 30),
            window_text=lambda: name, iface_value=types.SimpleNamespace(CurrentValue=value),
            is_enabled=lambda: True, is_visible=lambda: True)

    def test_truncation_and_runtime_identity(self):
        row = self.ns['elements'](self.control(name='x'*301))[0]
        self.assertFalse(row['nameComplete'])
        self.assertEqual(len(row['name']), 300)
        self.assertEqual(row['runtimeId'], [1, 2])

    def test_failed_value_and_incomplete_enumeration(self):
        child = self.control()
        del child.iface_value
        self.assertFalse(self.ns['elements'](child)[0]['valueComplete'])
        rows = self.ns['elements'](self.control(children=[self.control() for _ in range(501)]))
        self.assertEqual(len(rows), 501)
        self.assertFalse(self.ns['LAST_ENUMERATION_COMPLETE'])

    def test_controls_without_value_pattern_do_not_make_text_incomplete(self):
        button = self.control(name='Save', role='Button')
        del button.iface_value
        self.assertTrue(self.ns['elements'](button)[0]['valueComplete'])
        document = self.control(name='Draft', role='Document')
        del document.iface_value
        self.assertFalse(self.ns['elements'](document)[0]['valueComplete'])

    def test_edit_target_uses_the_same_uia_name_for_capture_and_action(self):
        field = self.control(name='13711112222', value='13711112222', accessible_name='手机号')
        window = self.control(role='Window', children=[field])
        self.assertEqual(self.ns['elements'](window)[1]['name'], '手机号')
        self.assertEqual(self.ns['find_control'](window,
            {'kind': 'role', 'role': 'Edit', 'name': '手机号'}, True), [field])
        self.assertEqual(self.ns['find_control'](window,
            {'kind': 'label', 'label': '手机号'}, True), [field])

if __name__ == '__main__':
    unittest.main()
