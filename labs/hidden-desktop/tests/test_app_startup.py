"""启动衔接的合成验证；真实能力分发 + FakeApi，不启动应用或读取私有学习记录。"""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app_startup import load_presets, select_started_window, WINDOW_WAIT_SECONDS
from capabilities import CapabilityRuntime, CapabilityError
from test_hidden_desktop import make


class StartupTests(unittest.TestCase):
    def setUp(self):
        self.desktop, self.api, self.clock = make()
        self.desktop.open()
        self.desktop.start(sys.executable)
        self.addCleanup(self.desktop.close)
        self.runtime = CapabilityRuntime(clock=self.clock)
        self.runtime.desktop = self.desktop
        self.arguments = {'app': 'custom', 'path': sys.executable, 'args': ''}
        self.presets = {'sample': {'app': 'custom', 'path': sys.executable, 'args': '',
                        'label': 'Synthetic', 'mainWindow': {'className': 'SampleUI', 'title': 'Sample'}}}
        self.calls = []
        invoke = self.runtime.invoke
        def traced(name, arguments):
            self.calls.append(name)
            return invoke(name, arguments)
        self.runtime.invoke = traced

    def window(self, *, owned=True, visible=True, title='Sample', class_name='SampleUI', image=None):
        pid = self.api._pid()
        self.api.processes[pid] = {'desktop': self.desktop.name, 'job': self.desktop.job if owned else None,
                                   'image': image or sys.executable, 'alive': True}
        if owned:
            self.api.job_pids[self.desktop.job].append(pid)
        window = {'hwnd': self.api._handle(), 'pid': pid, 'desktop': self.desktop.name,
                  'visible': visible, 'title': title, 'class': class_name, 'root': True, 'ex_style': 0,
                  'minimized': False, 'rect': [50, 50, 850, 650], 'client': [0, 0, 800, 600]}
        self.api.windows.append(window)
        return window

    def run_startup(self, sleep=None):
        return select_started_window(self.runtime, self.arguments, self.presets,
                                     clock=self.clock, sleep=sleep or self.clock.sleep)

    def test_child_process_window_is_selected_and_independently_verified(self):
        window = self.window()
        self.window(owned=False)  # 外来同名窗口不能进入候选。
        self.window(title='Other', class_name='SampleUI')
        result = self.run_startup()
        self.assertEqual(result['window']['hwnd'], window['hwnd'])
        self.assertNotEqual(result['identity']['pid'], self.desktop.pid)
        self.assertTrue(result['identity']['inJob'])
        self.assertTrue(result['unique'])
        self.assertEqual(self.calls, ['observe.window.enumerate', 'locate.window',
                                     'verify.target.identity', 'observe.window.enumerate'])
        self.assertEqual(self.runtime.actions, 0)
        self.assertEqual(len(self.api.launched), 1)
        self.assertFalse(any(call[0] in ('send', 'show_no_activate', 'place_no_activate') for call in self.api.calls))

    def test_delayed_window_only_repeats_observation(self):
        def sleep(seconds):
            self.clock.sleep(seconds)
            if self.clock() >= .4 and not any(w['title'] == 'Sample' for w in self.api.windows):
                self.window()
        result = self.run_startup(sleep)
        self.assertEqual(result['attempts'], 3)
        self.assertEqual(self.calls.count('locate.window'), 1)
        self.assertEqual(len(self.api.launched), 1)

    def test_matching_hidden_window_waits_for_visibility(self):
        window = self.window(visible=False)
        def sleep(seconds):
            self.clock.sleep(seconds)
            window['visible'] = True
        self.assertEqual(self.run_startup(sleep)['attempts'], 2)

    def test_duplicates_including_hidden_match_stop_without_selection(self):
        self.window()
        self.window(visible=False)
        with self.assertRaises(CapabilityError) as caught:
            self.run_startup()
        self.assertEqual(caught.exception.code, 'target-not-unique')
        self.assertNotIn('locate.window', self.calls)
        self.assertIsNone(self.desktop.target)

    def test_no_match_wrong_title_or_class_and_foreign_match_timeout(self):
        self.window(owned=False)
        self.window(title='Sample suffix')
        self.window(class_name='Other')
        deadline = self.desktop.deadline
        with self.assertRaises(CapabilityError) as caught:
            self.run_startup()
        self.assertEqual(caught.exception.code, 'target-windows-absent')
        self.assertEqual(self.clock(), WINDOW_WAIT_SECONDS)
        self.assertEqual(self.desktop.deadline, deadline)
        self.assertNotIn('locate.window', self.calls)
        self.assertEqual(len(self.api.launched), 1)

    def test_wrong_actual_executable_clears_selected_window(self):
        self.window(image='C:\\Synthetic\\other.exe')
        with self.assertRaises(CapabilityError) as caught:
            self.run_startup()
        self.assertEqual(caught.exception.code, 'target-identity-changed')
        self.assertIsNone(self.desktop.target)

    def test_same_user_and_session_checks_are_required(self):
        self.window()
        original = self.api.token_facts
        def token(pid):
            sid, session, integrity = original(pid)
            return (sid if pid == os.getpid() else 'different-user', session, integrity)
        self.api.token_facts = token
        with self.assertRaises(CapabilityError) as caught:
            self.run_startup()
        self.assertEqual(caught.exception.code, 'target-identity-changed')
        self.assertIsNone(self.desktop.target)

    def test_wrong_session_and_expired_lease_are_not_bypassed(self):
        self.window()
        session = self.api.session
        self.api.session = lambda pid: session(pid) if pid == os.getpid() else 9
        with self.assertRaises(CapabilityError) as caught:
            self.run_startup()
        self.assertEqual(caught.exception.code, 'target-identity-changed')
        self.assertIsNone(self.desktop.target)
        self.api.session = session
        self.clock.sleep(self.desktop.remaining()+1)
        deadline = self.desktop.deadline
        with self.assertRaises(CapabilityError) as caught:
            self.run_startup()
        self.assertEqual(caught.exception.code, 'lease-expired')
        self.assertEqual(self.desktop.deadline, deadline)

    def test_disappearing_window_is_not_replaced_with_another_candidate(self):
        window = self.window()
        original = self.runtime.invoke
        def invoke(name, args):
            if name == 'locate.window':
                self.api.windows.remove(window)
            return original(name, args)
        self.runtime.invoke = invoke
        with self.assertRaises(CapabilityError):
            self.run_startup()
        self.assertIsNone(self.desktop.target)

    def test_duplicate_appearing_during_identity_check_is_rejected(self):
        self.window()
        original = self.runtime.invoke
        def invoke(name, args):
            result = original(name, args)
            if name == 'verify.target.identity':
                self.window()
            return result
        self.runtime.invoke = invoke
        with self.assertRaises(CapabilityError) as caught:
            self.run_startup()
        self.assertEqual(caught.exception.code, 'target-not-unique')
        self.assertIsNone(self.desktop.target)

    def test_instance_change_during_wait_stops_before_selection(self):
        def sleep(seconds):
            self.clock.sleep(seconds)
            self.desktop.context['instanceId'] = 'new-instance'
        with self.assertRaises(CapabilityError) as caught:
            self.run_startup(sleep)
        self.assertEqual(caught.exception.code, 'target-identity-changed')
        self.assertNotIn('locate.window', self.calls)

    def test_builtin_or_unconfigured_executable_keeps_original_path(self):
        self.arguments['app'] = 'builtin'
        self.assertIsNone(self.run_startup())
        self.arguments.update(app='custom', path='C:\\Synthetic\\unconfigured.exe')
        self.assertIsNone(self.run_startup())
        self.assertEqual(self.calls, [])


class PresetConfigTests(unittest.TestCase):
    def test_configuration_is_bounded_and_rejects_incomplete_or_fuzzy_window_rules(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'app-launch-presets.json'
            preset = {'label': 'Sample', 'app': 'custom', 'path': sys.executable, 'args': '',
                      'mainWindow': {'className': 'SampleUI', 'title': 'Sample'}}
            data = {'schemaVersion': 1, 'presets': {'sample': preset}}
            path.write_text(json.dumps(data), encoding='utf-8')
            self.assertEqual(load_presets(folder), data['presets'])
            for invalid in ({}, {'title': 'Sample'}, {'className': '', 'title': 'Sample'},
                            {'className': 'SampleUI', 'title': 'Sample', 'largest': True}, None):
                changed = copy.deepcopy(data)
                changed['presets']['sample']['mainWindow'] = invalid
                path.write_text(json.dumps(changed), encoding='utf-8')
                with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                    load_presets(folder)


if __name__ == '__main__':
    unittest.main()
