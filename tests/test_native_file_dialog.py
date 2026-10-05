"""Exercise provider selection and dispatch for the standard Windows filename edit."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest


class NativeFileDialogTests(unittest.TestCase):
    def setUp(self):
        source = ast.parse(Path('src/runtime/desktop/worker.py').read_text(encoding='utf-8'))
        names = {'native_file_name_edit', 'resolve_action', '_execute', 'type_unicode'}
        functions = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in names]
        self.events = []
        self.control = SimpleNamespace(
            element_info=SimpleNamespace(control_type='Edit', automation_id='1001', class_name='Edit'),
            click_input=lambda: self.events.append('click'),
            iface_value=SimpleNamespace(SetValue=lambda value: self.events.append(('uia', value))),
            set_edit_text=lambda value: self.events.append(('uia', value)))
        self.ns = {
            'current_window': lambda: SimpleNamespace(set_focus=lambda: None),
            'controlled_foreground': lambda: True,
            'probe': lambda **kwargs: {'foreground': True, 'permissionsCompatible': True},
            'find_control': lambda *args: [self.control],
            'hotkey_with_release': lambda *keys: self.events.append(('hotkey', keys)),
            'pyautogui': SimpleNamespace(write=lambda value, **kwargs: self.events.append(('keyboard', value))),
            'clipboard_plain_text_available': lambda: False,
            'ACTION_DISPATCHED': False,
            'CURRENT_PROVIDER': None,
        }
        exec(compile(ast.Module(body=functions, type_ignores=[]), '<worker>', 'exec'), self.ns)
        # 纯逻辑测试不真正调用 SendInput；记录传入的文件名即可。
        self.ns['type_unicode'] = lambda value, interval=0.01: self.events.append(('unicode', value))

    def action(self, text='report.txt'):
        return {'kind': 'type', 'target': {'kind': 'role', 'role': 'Edit', 'name': '文件名:'}, 'text': text}

    def test_standard_filename_is_typed_through_unicode_events(self):
        action = self.action()
        selected = self.ns['resolve_action'](action)['selected']
        self.assertEqual(selected, 'windows.win32.act')
        result = self.ns['_execute'](action, [selected])
        self.assertTrue(result['ok'])
        self.assertEqual(result['provider'], selected)
        self.assertEqual(self.events, ['click', ('hotkey', ('ctrl', 'a')), ('unicode', 'report.txt')])

    def test_non_ascii_filename_uses_unicode_events_without_clipboard(self):
        action = self.action('报告.txt')
        selected = self.ns['resolve_action'](action)['selected']
        self.assertEqual(selected, 'windows.win32.act')
        result = self.ns['_execute'](action, [selected])
        self.assertTrue(result['ok'])
        self.assertEqual(result['provider'], 'windows.win32.act')
        self.assertEqual(self.events, ['click', ('hotkey', ('ctrl', 'a')), ('unicode', '报告.txt')])

    def test_other_edit_keeps_uia_value_pattern(self):
        self.control.element_info.automation_id = 'CustomerPhone'
        action = self.action('13912345678')
        selected = self.ns['resolve_action'](action)['selected']
        self.assertEqual(selected, 'windows.uia.act')
        result = self.ns['_execute'](action, [selected])
        self.assertTrue(result['ok'])
        self.assertEqual(self.events, [('uia', '13912345678')])


class UnicodeTypingTests(unittest.TestCase):
    def setUp(self):
        source = ast.parse(Path('src/runtime/desktop/worker.py').read_text(encoding='utf-8'))
        names = {'type_unicode'}
        functions = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in names]
        self.codes = []
        self.foreground = True
        self.ns = {
            'time': __import__('time'),
            'controlled_foreground': lambda: self.foreground,
        }
        exec(compile(ast.Module(body=functions, type_ignores=[]), '<worker>', 'exec'), self.ns)

    def run_typing(self, text):
        self.ns['_send_unicode_key'] = lambda code, key_up: self.codes.append((code, key_up))
        self.ns['type_unicode'](text, interval=0)

    def test_bmp_characters_use_utf16_code_units_down_then_up(self):
        self.run_typing('A中')
        self.assertEqual(self.codes, [
            (ord('A'), False), (ord('A'), True),
            (ord('中'), False), (ord('中'), True),
        ])

    def test_supplementary_character_emits_surrogate_pair_in_order(self):
        self.run_typing('😀')
        self.assertEqual(self.codes, [(0xD83D, False), (0xD83D, True),
                                      (0xDE00, False), (0xDE00, True)])

    def test_refuses_when_dialog_is_not_foreground(self):
        self.foreground = False
        with self.assertRaisesRegex(RuntimeError, '前台'):
            self.ns['type_unicode']('x', interval=0)


if __name__ == '__main__':
    unittest.main()
