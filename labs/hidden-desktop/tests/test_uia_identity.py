"""全树定位后的当前身份与 Raw 祖先证明；不连接真实窗口。"""
import copy
import ctypes as C
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import uia_client as uia
from uia_identity import IDENTITY_KEYS, same_identity


class IdentityTests(unittest.TestCase):
    def fixture(self):
        registry, closed = {}, []
        class Element:
            def __init__(self, key):
                self.key, self.pointer = key, C.c_void_p(key)
                registry[key] = self
            def close(self): closed.append(self.key)
            def call(self, slot, args, values):
                self_test.assertEqual(slot, 43)
                rect = values[0]._obj
                rect.left, rect.top, rect.right, rect.bottom = live_rect
        class Walker(Element):
            def call(self, slot, args, values):
                self_test.assertEqual(slot, 3)
                current, out = values
                out._obj.value = parent_map.get(current.value)
        class Client:
            def call(self, slot, args, values):
                self_test.assertEqual(slot, 16)
                values[0]._obj.value = 99
        self_test = self
        target, parent, root, walker = Element(1), Element(2), Element(3), Walker(99)
        tree = object.__new__(uia.UiaTree)
        tree.binding = dict(desktop='owned', instanceId='instance', session=5, hwnd=123,
                            windowPid=7, rootRuntimeId=[3])
        tree.window_binding = lambda: copy.deepcopy(tree.binding)
        tree.elements, tree.hwnd, tree.client = [target], 123, Client()
        tree.runtime_id = lambda element: [element.key]
        tree._integer = lambda element, slot: {20: 7, 21: 50004, 28: 1, 35: 0, 36: 0, 38: 0}[slot]
        tree._string = lambda element, slot: ''
        tree._owned = lambda element, windows: None
        tree.desktop = SimpleNamespace(windows=lambda: [123], api=SimpleNamespace(window_rect=lambda hwnd: [0, 0, 200, 200]))
        row = dict(index=0, role=50004, name='', autoId='', className='', runtimeId=[1], rect=[1, 1, 100, 30])
        live_rect = [2, 2, 100, 40]
        parent_map = {1: 2, 2: 3}
        return tree, row, registry, closed, live_rect, parent_map

    def test_current_ancestry_and_fresh_rectangle_are_checked_without_claiming_uniqueness(self):
        tree, row, registry, closed, rect, _ = self.fixture()
        with patch.object(uia, 'Com', side_effect=lambda pointer: registry[pointer.value]):
            proof = tree.prove_target(row)
        self.assertTrue(proof['identityRebound'])
        self.assertEqual(proof['ancestorDepth'], 2)
        self.assertEqual(row['rect'], rect)
        self.assertNotIn('globalUnique', proof)
        self.assertEqual(closed, [2, 3, 99])
        self.assertTrue(same_identity(proof, proof))

    def test_binding_change_and_replaced_element_refuse(self):
        tree, row, *_ = self.fixture()
        changed = {**tree.binding, 'instanceId': 'new'}
        tree.window_binding = lambda: changed
        with self.assertRaisesRegex(uia.UiaError, 'identity-changed'):
            tree.prove_target(row)
        tree.window_binding = lambda: tree.binding
        row['runtimeId'] = [999]
        with self.assertRaisesRegex(uia.UiaError, 'identity-changed'):
            tree.prove_target(row)

    def test_missing_ancestor_or_outside_geometry_refuse_and_release(self):
        for kind in ('ancestry', 'geometry'):
            tree, row, registry, closed, rect, parents = self.fixture()
            if kind == 'ancestry': parents.clear()
            else: rect[2] = 300
            with patch.object(uia, 'Com', side_effect=lambda pointer: registry[pointer.value]):
                with self.assertRaisesRegex(uia.UiaError, 'ancestry-unproven'):
                    tree.prove_target(row)
            self.assertIn(99, closed)

    def test_expected_identity_requires_all_fields_and_detects_every_binding_change(self):
        proof = {key: [7] if key.endswith('RuntimeId') or key == 'runtimeId' else key for key in IDENTITY_KEYS}
        self.assertTrue(same_identity(proof, proof))
        self.assertFalse(same_identity({}, proof))
        for key in IDENTITY_KEYS:
            self.assertFalse(same_identity({**proof, key: None}, proof), key)

    def native_fixture(self):
        tree,row,registry,closed,rect,parents=self.fixture()
        read=tree._integer
        tree._integer=lambda element,slot: 456 if element.key==2 and slot==36 else read(element,slot)
        api=tree.desktop.api
        api.process_in_job=lambda pid,job:pid==7 and job=='job'
        api.session=lambda pid:5
        api.window_pid=lambda hwnd:7
        api.u=SimpleNamespace(GetAncestor=lambda hwnd,kind:123)
        tree.desktop.context={'session':5};tree.desktop.job='job'
        tree.desktop.assert_target=lambda hwnd:hwnd
        tree._owned=lambda element,windows:uia.UiaTree._owned(tree,element,windows)
        return tree,row,registry,closed,rect,parents

    def test_explicit_native_strategy_proves_same_owned_window_without_claiming_uniqueness(self):
        tree,row,registry,closed,*_=self.native_fixture()
        with patch.object(uia,'Com',side_effect=lambda pointer:registry[pointer.value]):
            proof=tree.prove_target_from_native_ancestor(row)
        self.assertEqual(proof['strategy'],'uia-to-owned-native-ancestor')
        self.assertEqual(proof['ancestorDepth'],1)
        self.assertEqual(proof['nativeAncestor']['hwnd'],456)
        self.assertNotIn('globalUnique',proof)
        self.assertEqual(closed,[2,99])

    def test_native_anchor_rejects_other_owned_window_job_session_and_native_pid_mismatch(self):
        for kind in ('other-window','job','session','native-pid'):
            tree,row,registry,closed,*_=self.native_fixture()
            if kind=='other-window':
                tree.desktop.windows=lambda:[123,456]
                tree.desktop.api.u.GetAncestor=lambda hwnd,kind:456
            elif kind=='job':tree.desktop.api.process_in_job=lambda pid,job:False
            elif kind=='session':tree.desktop.api.session=lambda pid:6
            else:tree.desktop.api.window_pid=lambda hwnd:8
            with self.subTest(kind=kind),patch.object(uia,'Com',side_effect=lambda pointer:registry[pointer.value]):
                with self.assertRaises(uia.UiaError):tree.prove_target_from_native_ancestor(row)

    def test_native_strategy_does_not_increase_depth_budget_or_accept_missing_ancestry(self):
        tree,row,registry,closed,rect,parents=self.fixture()
        element_type=type(tree.elements[0])
        tree.binding['rootRuntimeId']=[999]
        for key in range(4,22):registry[key]=element_type(key)
        parents.update({key:key+1 for key in range(1,21)})
        with patch.object(uia,'Com',side_effect=lambda pointer:registry[pointer.value]):
            with self.assertRaisesRegex(uia.UiaError,'ancestry-unproven'):
                tree.prove_target_from_native_ancestor(row)
        self.assertEqual(len(closed),17)  # 16 个已读祖先 + walker；没有继续读第 17 层。


if __name__ == '__main__': unittest.main()
