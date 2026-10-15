"""合成 COM provider：核对角色批量缓存与本地过滤，零桌面、零应用输入。"""
import ctypes as C
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import uia_client as uia
import capabilities as caps


class FakeCom:
    def __init__(self, fixture, kind, value=None):
        self.fixture, self.kind, self.value = fixture, kind, value
        self.closed = False
        self.pointer = C.c_void_p(len(fixture.registry) + 1)
        fixture.registry[self.pointer.value] = self

    def close(self):
        self.closed = True

    def call(self, slot, _args=(), values=()):
        fixture = self.fixture
        if self.kind == 'root':
            assert slot in (6, 8)
            if slot == 8:
                scope, condition, cache, out = values
                assert cache.value == fixture.tree.role_cache.pointer.value
            else:
                scope, condition, out = values
            assert scope == 4
            roles = fixture.registry[condition.value].value
            fixture.queries.append(slot)
            assert roles is None
            rows = fixture.rows
            result = FakeCom(fixture, 'array', rows)
            out._obj.value = result.pointer.value
        elif self.kind == 'array':
            if slot == 3:
                values[0]._obj.value = len(self.value)
            elif slot == 4:
                index, out = values
                fixture.element_reads += 1
                element = FakeCom(fixture, 'element', self.value[index])
                out._obj.value = element.pointer.value
            else:
                raise AssertionError(('unexpected-array-slot', slot))
        elif self.kind == 'element':
            cached = slot >= 52
            if slot >= 52:
                assert slot == 53  # 缓存中只含角色，不允许拿旧详细属性当当前事实。
                fixture.cached_reads += 1
                slot -= 32
            else:
                fixture.live_reads += 1
            if slot == 43:
                rect = values[0]._obj
                rect.left, rect.top, rect.right, rect.bottom = 1, 1, 100, 40
            else:
                if slot == 21:
                    fixture.role_reads += 1
                values[0]._obj.value = {20: self.value.get('pid', 7), 21: self.value['role'],
                    28: self.value.get('enabled', 1), 35: self.value.get('password', 0),
                    36: 0, 38: self.value.get('offscreen', 0)}[slot]
                if slot == 21 and not cached:
                    values[0]._obj.value = self.value.get('currentRole', self.value['role'])
        else:
            raise AssertionError(('unexpected-interface', self.kind))


class Fixture:
    def __init__(self, rows):
        self.rows, self.registry = rows, {}
        self.queries = []
        self.element_reads = self.role_reads = 0
        self.cached_reads = self.live_reads = 0
        self.target_checks = []
        tree = object.__new__(uia.UiaTree)
        tree.desktop = SimpleNamespace(context={'session': 5}, job=99,
            windows=lambda: [123], assert_target=lambda hwnd: self.target_checks.append(hwnd),
            api=SimpleNamespace(process_in_job=lambda pid, job: pid == 7 and job == 99, session=lambda _pid: 5))
        tree.hwnd, tree.elements = 123, []
        tree.client = FakeCom(self, 'client')
        tree.root = FakeCom(self, 'root')
        tree.condition = FakeCom(self, 'condition', None)
        tree.role_cache = FakeCom(self, 'cache')
        tree.array = None
        tree.runtime_id = lambda element: [7, element.pointer.value]
        tree.ole = SimpleNamespace(CoUninitialize=lambda: None)
        tree._string = lambda element, slot: element.value.get({23: 'name', 29: 'autoId', 30: 'className'}[slot - 32 if slot >= 52 else slot], '')
        self.tree = tree

    def com(self, pointer):
        return self.registry[pointer.value]

    def enumerate(self, roles=None, budget=None, settle=False):
        with patch.object(uia, 'Com', self.com), patch.object(uia.time, 'sleep'):
            return self.tree.enumerate(roles, budget, settle)


class RoleQueryTests(unittest.TestCase):
    def test_identity_deferred_keeps_all_candidates_and_default_remains_strict(self):
        fixture = Fixture([{'role':50020,'name':'Synthetic changing text'}, {'role':50020,'name':'Target'}])
        def unavailable(element):raise uia.UiaError('uia-runtime-id-unavailable')
        fixture.tree.runtime_id=unavailable
        with patch.object(uia,'Com',fixture.com):
            rows=fixture.tree.enumerate({50020},settle=False,identities=False)
        self.assertEqual(len(rows),2)
        self.assertTrue(all(r['runtimeId'] is None for r in rows))
        with self.assertRaisesRegex(uia.UiaError,'uia-runtime-id-unavailable'):
            fixture.enumerate({50020})

    def test_native_find_and_array_length_have_separate_timers(self):
        fixture = Fixture([{'role': 50004}])
        with patch.object(uia.time, 'perf_counter', side_effect=[1, 3, 3.5, 4, 4.1, 4.2]):
            fixture.enumerate({50004})
        self.assertEqual(fixture.tree.timings['nativeFindMs'], 2000)
        self.assertEqual(fixture.tree.timings['arrayCountMs'], 500)

    def test_batched_roles_only_read_detailed_live_properties_for_one_edit(self):
        fixture = Fixture([{'role': 50006}] * 618 + [{'role': 50004, 'name': 'search'}])
        rows = fixture.enumerate({50004}, settle=True)
        self.assertEqual([r['name'] for r in rows], ['search'])
        self.assertEqual(fixture.queries, [8])
        self.assertEqual((fixture.element_reads, fixture.role_reads), (619, 620))
        self.assertGreater(fixture.cached_reads, 0)
        self.assertLess(fixture.live_reads, 15)
        self.assertEqual(fixture.tree.available, 619)
        self.assertFalse(fixture.tree.truncated)
        self.assertEqual(fixture.target_checks, [123, 123])
        self.assertTrue(all(obj.closed for obj in fixture.registry.values() if obj.kind in ('array', 'condition') and obj is not fixture.tree.condition))

    def test_unfiltered_query_still_reads_full_tree(self):
        fixture = Fixture([{'role': 50006}, {'role': 50004}])
        self.assertEqual(len(fixture.enumerate()), 2)
        self.assertEqual(fixture.queries, [6])
        self.assertEqual(fixture.element_reads, 2)

    def test_multiple_roles_share_one_batch_and_preserve_duplicates(self):
        fixture = Fixture([{'role': 50004}, {'role': 50004, 'offscreen': 1}, {'role': 50000}, {'role': 50006}])
        rows = fixture.enumerate({50004, 50000})
        self.assertEqual(len(rows), 3)
        self.assertTrue(rows[1]['offscreen'])
        self.assertEqual(fixture.queries, [8])

    def test_truncated_query_cannot_prove_uniqueness_even_with_one_found(self):
        fixture = Fixture([{'role': 50004, 'name': 'same'}] * 3)
        rows = fixture.enumerate({50004}, budget=1)
        self.assertTrue(fixture.tree.truncated)
        self.assertEqual(fixture.tree.available, 3)
        class Tree:
            truncated = True
            available = 3
            def enumerate(self, roles=None):
                return rows
        with self.assertRaises(caps.CapabilityError) as caught:
            caps.CapabilityRuntime()._locate(Tree(), {'kind': 'role', 'role': 'Edit', 'value': 'same'})
        self.assertEqual(caught.exception.code, 'enumeration-truncated')

    def test_ownership_and_password_checks_still_fail_closed(self):
        for extra, expected in [({'pid': 999}, 'uia-element-process-mismatch'), ({'password': 1}, 'uia-password-element-forbidden')]:
            fixture = Fixture([{'role': 50004, **extra}])
            with self.assertRaisesRegex(uia.UiaError, expected):
                fixture.enumerate({50004})
            self.assertTrue(all(obj.closed for obj in fixture.registry.values() if obj.kind in ('array', 'element') or obj.kind == 'condition' and obj is not fixture.tree.condition))

    def test_empty_roles_match_nothing_and_unknown_roles_refuse(self):
        fixture = Fixture([{'role': 50004}])
        self.assertEqual(fixture.enumerate(set()), [])
        with self.assertRaisesRegex(uia.UiaError, 'uia-unsupported-role'):
            fixture.enumerate({99999})

    def test_patterns_recheck_current_ownership_and_password_after_cached_observation(self):
        fixture = Fixture([{'role': 50004}])
        fixture.enumerate({50004})
        fixture.rows[0]['password'] = 1
        with self.assertRaisesRegex(uia.UiaError, 'uia-password-element-forbidden'):
            fixture.tree.value(0)
        self.assertGreater(fixture.live_reads, 0)

    def test_changed_current_role_is_refused_instead_of_trusting_cached_tag(self):
        fixture = Fixture([{'role': 50004, 'currentRole': 50000}])
        with self.assertRaisesRegex(uia.UiaError, 'uia-query-role-mismatch'):
            fixture.enumerate({50004})
        self.assertEqual(fixture.tree.elements, [])


if __name__ == '__main__':
    unittest.main()
