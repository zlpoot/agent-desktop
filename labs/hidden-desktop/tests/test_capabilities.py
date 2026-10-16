"""基础能力声明与调度的离线测试：不创建桌面、不启动进程、不加载任何窗口。

覆盖三件事：
  1. 声明必须满足格式约束（这是"分装好"的定义）；
  2. 可用性判定按事实走，未实现的一律不可用；
  3. 内部异常被翻译成声明里的稳定错误码，调用方不需要解析 message。
"""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import capabilities as caps  # noqa: E402
from hidden_desktop import Blocked, CleanupUnconfirmed  # noqa: E402
from uia_client import UiaError, ROLE_NAMES  # noqa: E402
from uia_identity import IDENTITY_KEYS  # noqa: E402


class DeclarationTests(unittest.TestCase):
    """F1：声明格式约束。违反这些约束的声明不允许合并。"""

    def test_ids_are_unique_and_well_formed(self):
        ids = [c["id"] for c in caps.CAPABILITIES]
        self.assertEqual(len(ids), len(set(ids)), "能力 id 必须唯一")
        for capability_id in ids:
            self.assertRegex(capability_id, r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$",
                             "id 必须是小写点分形式")

    def test_layers_and_operations_are_from_the_closed_set(self):
        layers = {"environment", "observe", "ground", "execute", "verify", "control"}
        operations = {"attach", "observe", "locate", "act", "verify", "release"}
        for entry in caps.CAPABILITIES:
            self.assertIn(entry["layer"], layers, entry["id"])
            self.assertIn(entry["operation"], operations, entry["id"])

    def test_every_capability_declares_no_user_impact(self):
        """本家族的定义性特征：不碰用户的鼠标键盘焦点。这条不能有例外。"""
        for entry in caps.CAPABILITIES:
            self.assertEqual(entry["effects"], caps.NO_USER_IMPACT, entry["id"])
            self.assertIs(entry["effects"]["touchesUserDesktop"], False, entry["id"])
            self.assertIs(entry["effects"]["sendsSystemInput"], False, entry["id"])

    def test_every_refusal_code_is_declared_in_errors(self):
        """F3 的前置：拒绝条件必须能被程序处理，所以错误码必须在 errors 里。"""
        for entry in caps.CAPABILITIES:
            codes = {error["code"] for error in entry["errors"]}
            for refusal in entry["refuses"]:
                self.assertIn(refusal["code"], codes,
                              "%s 的拒绝码 %s 未在 errors 中声明" % (entry["id"], refusal["code"]))

    def test_error_entries_have_stable_shape(self):
        kinds = {"unavailable", "stale", "blocked", "unknown"}
        for entry in caps.CAPABILITIES:
            for error in entry["errors"]:
                self.assertIn(error["kind"], kinds, entry["id"])
                self.assertIsInstance(error["retryable"], bool, entry["id"])
                self.assertRegex(error["code"], r"^[a-z][a-z0-9-]*$", entry["id"])

    def test_verified_requires_conformance_and_evidence(self):
        """F2 + F5：没有合成用例的能力不允许是 verified。"""
        for entry in caps.CAPABILITIES:
            if entry["status"] != "verified":
                continue
            self.assertGreater(entry["conformance"]["cases"], 0, entry["id"])
            self.assertTrue(entry["conformance"]["suite"], entry["id"])
            hidden = [e for e in entry["environments"] if e["kind"] == "hidden-desktop"]
            self.assertTrue(hidden, entry["id"])
            self.assertTrue(hidden[0]["evidence"], entry["id"])
            self.assertIn(hidden[0]["status"], ("verified", "partial"), entry["id"])

    def test_planned_capabilities_have_no_false_claims(self):
        planned = [c for c in caps.CAPABILITIES if c["status"] == "planned"]
        self.assertTrue(planned, "应当保留未实现的能力以便如实展示")
        for entry in planned:
            self.assertEqual(entry["conformance"]["cases"], 0, entry["id"])
            self.assertEqual(entry["errors"][0]["code"], "not-implemented", entry["id"])

    def test_user_desktop_is_forbidden_everywhere(self):
        for entry in caps.CAPABILITIES:
            for environment in entry["environments"]:
                if environment["kind"] == "user-desktop":
                    self.assertEqual(environment["status"], "forbidden", entry["id"])

    def test_budget_is_finite(self):
        for entry in caps.CAPABILITIES:
            timeout = entry["budget"]["timeoutMs"]
            self.assertIsInstance(timeout, int, entry["id"])
            self.assertGreater(timeout, 0, entry["id"])
            self.assertLessEqual(timeout, 60000, entry["id"])

    def test_input_schema_is_renderable(self):
        """页面按声明生成表单，所以字段类型必须在受支持集合内。"""
        allowed = {"string", "integer", "boolean", "choice", "target"}
        for entry in caps.CAPABILITIES:
            schema = entry["input"]
            self.assertEqual(schema["type"], "object", entry["id"])
            for name, spec in schema.get("properties", {}).items():
                self.assertIn(spec["type"], allowed, "%s.%s" % (entry["id"], name))
                if spec["type"] == "choice":
                    self.assertTrue(spec.get("choices"), "%s.%s 需要 choices" % (entry["id"], name))

    def test_no_application_name_leaks_into_declarations(self):
        """能力按界面结构选择，不按应用选择。"""
        banned = ("cloudmusic", "netease", "网易云", "chrome", "notepad", "doubao", "豆包")
        for entry in caps.CAPABILITIES:
            text = "%s %s" % (entry["id"], entry["summary"])
            for word in banned:
                self.assertNotIn(word.lower(), text.lower(), entry["id"])


class EvaluationTests(unittest.TestCase):
    """可用性判定：按事实走，事实未知也算不满足（fail-closed）。"""

    def setUp(self):
        self.runtime = caps.CapabilityRuntime()

    def test_facts_without_a_session_are_all_false(self):
        facts = self.runtime.facts()
        self.assertFalse(facts["hiddenDesktopOpen"])
        self.assertFalse(facts["uniqueOwnedWindow"])
        self.assertFalse(facts["leaseActive"])

    def test_planned_is_unavailable(self):
        facts = self.runtime.facts()
        entry = caps.CAPABILITY_INDEX["locate.ocr"]
        verdict = self.runtime.evaluate(entry, facts)
        self.assertEqual(verdict["availability"], "unavailable")
        self.assertIn("尚未实现", verdict["reasons"])

    def test_missing_requirement_blocks_and_explains(self):
        facts = self.runtime.facts()
        entry = caps.CAPABILITY_INDEX["act.click"]
        verdict = self.runtime.evaluate(entry, facts)
        self.assertEqual(verdict["availability"], "unavailable")
        self.assertTrue(any("hiddenDesktopOpen" in r or "uniqueOwnedWindow" in r
                            for r in verdict["reasons"]), verdict["reasons"])

    def test_unknown_fact_is_pending_not_ready(self):
        entry = caps.CAPABILITY_INDEX["act.click"]
        verdict = self.runtime.evaluate(entry, {})
        self.assertEqual(verdict["availability"], "pending")

    def test_all_requirements_satisfied_is_ready(self):
        entry = caps.CAPABILITY_INDEX["act.click"]
        verdict = self.runtime.evaluate(entry, {"hiddenDesktopOpen": True,
                                                "targetWindowResolved": True})
        self.assertEqual(verdict["availability"], "ready")

    def test_target_window_resolution_is_the_gate_not_visibility(self):
        """目标的判据是「解析出唯一目标窗口」，裸可见性不作为门槛。

        实测某 CEF 音乐播放器启动后 1.6 秒内界面窗口是不可见的 32×32，约 2.8 秒才变为
        可见的 1601×1128；同时它还会建出十几个顶层窗口（输入法指示器、歌词窗、消息窗等）。
        所以「可见且唯一」在启动早期会先后给出 0 个和 1 个，而调用方需要的是能显式选定、
        并且能区分「还没起来」与「选不准」的判据。
        """
        entry = caps.CAPABILITY_INDEX["act.click"]
        verdict = self.runtime.evaluate(entry, {"hiddenDesktopOpen": True,
                                                "targetWindowResolved": False})
        self.assertEqual(verdict["availability"], "unavailable")
        self.assertTrue(any("targetWindowResolved" in r for r in verdict["reasons"]))
        for capability in caps.CAPABILITIES:
            self.assertNotIn("uniqueOwnedWindow", capability.get("requires", []),
                             capability["id"])

    def test_refusal_only_when_there_is_no_session(self):
        """不制造副作用的检查：没有会话时，一切依赖桌面的能力都应被拒。"""
        with self.assertRaises(caps.CapabilityError) as caught:
            self.runtime.invoke("act.click", {"target": {"kind": "autoId", "value": "1002"}})
        self.assertIn(str(caught.exception), ("hidden-desktop-not-open", "requires-unique-window"))


class DispatchTests(unittest.TestCase):
    """调度与错误翻译：调用方只依赖声明的错误码。"""

    def setUp(self):
        self.runtime = caps.CapabilityRuntime()

    def test_unknown_capability_is_refused(self):
        with self.assertRaises(caps.CapabilityError) as caught:
            self.runtime.invoke("act.does_not_exist", {})
        self.assertEqual(str(caught.exception), "unsupported-capability")

    def test_all_planned_capabilities_refuse_with_not_implemented(self):
        for entry in caps.CAPABILITIES:
            if entry["status"] != "planned":
                continue
            with self.assertRaises(caps.CapabilityError) as caught:
                self.runtime.invoke(entry["id"], {})
            self.assertEqual(str(caught.exception), "not-implemented", entry["id"])

    def test_every_verified_capability_has_an_implementation(self):
        """声明为 verified 却没有实现方法，是必须挡住的错误。"""
        missing = []
        for entry in caps.CAPABILITIES:
            if entry["status"] != "verified":
                continue
            handler = "_do_" + entry["id"].replace(".", "_")
            if not hasattr(self.runtime, handler):
                missing.append(entry["id"])
        self.assertEqual(missing, [], "缺少实现: %s" % missing)

    def test_budget_guard_refuses_execute_layer(self):
        self.runtime.actions = self.runtime.max_actions
        with self.assertRaises(caps.CapabilityError) as caught:
            self.runtime.invoke("act.cancel", {})
        self.assertEqual(str(caught.exception), "budget-exhausted")

    def test_control_capabilities_do_not_consume_budget(self):
        info = self.runtime.invoke("control.budget.consume", {})
        self.assertEqual(info["result"]["actionsUsed"], 0)
        self.assertTrue(info["result"]["readOnly"])


class TranslationTests(unittest.TestCase):
    """内部异常 → 声明错误码。"""

    def test_blocked_codes_map_to_declared_codes(self):
        cases = {
            "hidden_desktop_not_open": "hidden-desktop-not-open",
            "hidden_desktop_lease_expired": "lease-expired",
            "target_not_unique": "target-not-unique",
            "target_not_owned_process": "target-not-owned",
            "target_outside_owned_job": "target-outside-owned-job",
            "interactive_session_not_active": "session-not-default",
            "ordinary_medium_required": "integrity-not-medium",
            "already_started": "already-started",
        }
        for internal, declared in cases.items():
            self.assertEqual(str(caps._as_code(Blocked(internal))), declared)

    def test_cleanup_unconfirmed_keeps_its_details(self):
        error = caps._as_code(CleanupUnconfirmed([{"step": "desktop-present"}]))
        self.assertEqual(str(error), "cleanup-unconfirmed")
        self.assertEqual(error.detail, [{"step": "desktop-present"}])

    def test_uia_unsupported_pattern_maps_to_value_pattern(self):
        error = caps._as_code(UiaError("uia-hresult-80040204"))
        self.assertEqual(str(error), "value-pattern-unavailable")

    def test_unknown_internal_error_never_invents_a_specific_code(self):
        error = caps._as_code(RuntimeError("something odd"))
        self.assertEqual(str(error), "dispatch-effect-unknown")

    def test_runtime_translates_handler_exceptions(self):
        """处理器里抛出的内部异常，必须被翻译后再交给调用方。"""
        runtime = caps.CapabilityRuntime()

        def boom(_arguments):
            raise Blocked("target_desktop_mismatch")

        runtime._do_probe_boom = boom
        caps.CAPABILITY_INDEX["probe.boom"] = {
            **caps.CAPABILITY_INDEX["env.identity.probe"], "id": "probe.boom", "layer": "verify"}
        try:
            with self.assertRaises(caps.CapabilityError) as caught:
                runtime.invoke("probe.boom", {})
            self.assertEqual(str(caught.exception), "target-not-owned")
            self.assertEqual(caught.exception.kind, "blocked")
        finally:
            del caps.CAPABILITY_INDEX["probe.boom"]

    def test_error_kinds_are_declared_somewhere(self):
        for code in caps.ERROR_KINDS:
            self.assertRegex(code, r"^[a-z][a-z0-9-]*$")

    def test_every_internal_error_code_maps_to_a_stable_code(self):
        """门禁：内部错误码 → 稳定错误码，不允许退化成 dispatch-effect-unknown。

        调用方只依赖 code，所以"某个内部失败没有归属"本身就是缺陷。真实应用验证时
        正是 `capture_requires_unique_window` 未映射，让调用方收到无意义的
        dispatch-effect-unknown。这里直接从源码里扫出全部内部码逐个检查。
        """
        here = Path(__file__).resolve().parents[1]
        pattern = re.compile(r'Blocked\(\s*"([a-z0-9_]+)"')
        uia_pattern = re.compile(r'UiaError\(\s*"([a-z0-9-]+)"')
        sources = {name: (here / name).read_text(encoding="utf-8")
                   for name in ("hidden_desktop.py", "uia_client.py")}
        internal = set(pattern.findall(sources["hidden_desktop.py"])) \
            | set(uia_pattern.findall(sources["uia_client.py"]))
        self.assertGreater(len(internal), 20, "扫描没抓到内部码，正则可能失效")

        unmapped = []
        for code in sorted(internal):
            error = Blocked(code) if "_" in code else UiaError(code)
            if str(caps._as_code(error)) == "dispatch-effect-unknown":
                unmapped.append(code)
        self.assertEqual(unmapped, [], "以下内部码没有稳定归属：%s" % unmapped)

    def test_every_declared_code_is_in_the_catalog(self):
        """声明里出现的错误码都必须有分类，否则调用方拿不到 kind。"""
        for entry in caps.CAPABILITIES:
            for error in entry.get("errors", []):
                self.assertIn(error["code"], caps.ERROR_KINDS, entry["id"])
        for code, (kind, retryable) in caps.ERROR_CATALOG.items():
            self.assertIn(kind, ("unavailable", "stale", "blocked", "unknown"), code)
            self.assertIsInstance(retryable, bool, code)

    def test_capture_honours_an_explicit_target_selection(self):
        """显式选定目标后，抓取不得再按"自动唯一"重算而忽略它。"""
        source = (Path(__file__).resolve().parents[1] / "hidden_desktop.py").read_text(encoding="utf-8")
        self.assertIn("target = hwnd if hwnd is not None else self.target_window()[0]",
                      source.replace("\r\n", "\n").replace("        ", "        "))


class LocateTruncationTests(unittest.TestCase):
    """没找到 ≠ 不存在：枚举被截断时不允许下"不存在"的结论。

    真实 CEF 应用在窗口定尺后会展开出 627 个元素，每个元素还要读 6 个 COM 属性。
    一旦树被预算截断，"匹配 0 个"就不再等价于"控件不存在"。
    """

    class StubTree:
        def __init__(self, rows, truncated=False, available=None):
            self.rows = rows
            self.truncated = truncated
            self.available = available if available is not None else len(rows)
            self.calls = []

        def enumerate(self, roles=None, budget=None):
            self.calls.append(roles)
            if roles is None:
                return self.rows
            return [row for row in self.rows if row["role"] in roles]

        def prove_target(self, row):
            return {'runtimeId': [1], 'identityRebound': True}

    @staticmethod
    def row(role=50000, name="ok", auto_id="", class_name="Edit", enabled=True):
        return {"index": 0, "role": role, "roleName": ROLE_NAMES.get(role, str(role)),
                "name": name, "autoId": auto_id, "className": class_name,
                "enabled": enabled, "offscreen": False, "native": 0,
                "rect": [0, 0, 10, 10]}

    def setUp(self):
        self.runtime = caps.CapabilityRuntime()

    def test_truncated_miss_is_reported_as_truncation_not_absence(self):
        tree = self.StubTree([], truncated=True, available=627)
        with self.assertRaises(caps.CapabilityError) as caught:
            self.runtime._locate(tree, {"kind": "autoId", "value": "1001"})
        self.assertEqual(str(caught.exception), "enumeration-truncated")
        self.assertIn("627", str(caught.exception.detail))

    def test_complete_miss_is_reported_as_not_unique(self):
        tree = self.StubTree([], truncated=False, available=0)
        with self.assertRaises(caps.CapabilityError) as caught:
            self.runtime._locate(tree, {"kind": "autoId", "value": "1001"})
        self.assertEqual(str(caught.exception), "target-not-unique")

    def test_role_locator_pushes_the_filter_into_uia(self):
        """按 role 定位要先在 UIA 侧过滤，否则每个元素 6 次 COM 读取代价太高。"""
        wanted = {k for k, v in ROLE_NAMES.items() if v.lower() == "edit"}
        tree = self.StubTree([self.row(role=sorted(wanted)[0], auto_id="1001")])
        located = self.runtime._locate(tree, {"kind": "role", "role": "Edit", "value": ""})
        self.assertEqual(located["autoId"], "1001")
        self.assertEqual(tree.calls, [wanted])

    def test_ambiguous_match_is_still_refused_even_when_complete(self):
        tree = self.StubTree([self.row(name="重复"), self.row(name="重复")], truncated=False)
        with self.assertRaises(caps.CapabilityError) as caught:
            self.runtime._locate(tree, {"kind": "label", "value": "重复"})
        self.assertEqual(str(caught.exception), "target-not-unique")

    def test_expected_identity_never_replaces_new_global_query(self):
        proof = dict(desktop='owned', instanceId='instance', session=5, hwnd=123,
                     windowPid=7, rootRuntimeId=[3], elementPid=7, runtimeId=[1], identityRebound=True)
        tree = self.StubTree([self.row(role=50004, class_name='')])
        tree.prove_target = lambda row: dict(proof)
        selected = self.runtime._locate(tree, {'kind': 'role', 'role': 'Edit'})
        proof['runtimeId'] = [999]
        with self.assertRaises(caps.CapabilityError) as caught:
            self.runtime._locate(tree, {'kind': 'role', 'role': 'Edit', 'expectedIdentity': selected['identity']})
        self.assertEqual(caught.exception.code, 'target-identity-changed')
        self.assertEqual(len(tree.calls), 2)

    def test_forged_identity_cannot_select_one_of_duplicate_controls(self):
        tree = self.StubTree([self.row(name='same'), self.row(name='same')])
        tree.prove_target = lambda row: self.fail('must reject ambiguity before identity comparison')
        with self.assertRaises(caps.CapabilityError) as caught:
            self.runtime._locate(tree, {'kind': 'role', 'role': 'Button', 'expectedIdentity': {}})
        self.assertEqual(caught.exception.code, 'target-not-unique')

    def test_explicit_native_ancestry_strategy_still_requires_global_uniqueness_and_expected_identity(self):
        tree=self.StubTree([self.row(role=50026,class_name='sample-editor')])
        proof={key:[7] if key.endswith('RuntimeId') or key=='runtimeId' else key for key in IDENTITY_KEYS}
        tree.prove_target=lambda row:self.fail('explicit mode must not silently use the default strategy')
        tree.prove_target_from_native_ancestor=lambda row:dict(proof,identityRebound=True,strategy='uia-to-owned-native-ancestor')
        spec=dict(kind='className',value='sample-editor',ancestryStrategy='owned-native-anchor')
        selected=self.runtime._locate(tree,spec)
        self.assertTrue(selected['identity']['globalUnique'])
        self.runtime._locate(tree,{**spec,'expectedIdentity':selected['identity']})
        with self.assertRaises(caps.CapabilityError) as caught:
            self.runtime._locate(tree,{**spec,'expectedIdentity':{**selected['identity'],'runtimeId':[99]}})
        self.assertEqual(caught.exception.code,'target-identity-changed')
        tree.rows.append(self.row(role=50026,class_name='sample-editor'))
        with self.assertRaises(caps.CapabilityError) as caught:self.runtime._locate(tree,spec)
        self.assertEqual(caught.exception.code,'target-not-unique')

    def test_uia_tree_declares_a_real_app_sized_budget(self):
        from uia_client import MAX_ELEMENTS
        self.assertGreaterEqual(MAX_ELEMENTS, 1000,
                                "上限低于真实应用的元素数会把'树太大'变成'能力不可用'")
        self.assertEqual(caps.CAPABILITY_INDEX["observe.uia.tree"]["budget"]["maxElements"],
                         MAX_ELEMENTS)
        self.assertGreaterEqual(caps.CAPABILITY_INDEX["observe.uia.tree"]["budget"]["timeoutMs"],
                                30000, "实测 627 个元素约 11 秒，预算必须留足")


class SummaryTests(unittest.TestCase):
    def test_target_selection_capabilities_exist(self):
        """真实应用验证暴露的两条必需能力必须存在且被声明为已实现。"""
        for capability_id in ("locate.window", "act.window.fit"):
            entry = caps.CAPABILITY_INDEX.get(capability_id)
            self.assertIsNotNone(entry, capability_id)
            self.assertEqual(entry["status"], "verified", capability_id)
            self.assertTrue(hasattr(caps.CapabilityRuntime,
                                    "_do_" + capability_id.replace(".", "_")), capability_id)
        window = caps.CAPABILITY_INDEX["locate.window"]
        self.assertEqual(window["requires"], ["hiddenDesktopOpen"])
        fit = caps.CAPABILITY_INDEX["act.window.fit"]
        self.assertEqual(fit["requires"], ["hiddenDesktopOpen", "targetWindowResolved"])
        self.assertIn("owned-window-size-budget",
                      {error["code"] for error in fit["errors"]})

    def test_capability_inventory_shape(self):
        counts = {}
        for entry in caps.CAPABILITIES:
            counts[entry["layer"]] = counts.get(entry["layer"], 0) + 1
        # 六层都必须有内容，否则目录不完整
        for layer in ("environment", "observe", "ground", "execute", "verify", "control"):
            self.assertIn(layer, counts, layer)
        verified = [c for c in caps.CAPABILITIES if c["status"] == "verified"]
        planned = [c for c in caps.CAPABILITIES if c["status"] == "planned"]
        self.assertGreaterEqual(len(verified), 15)
        self.assertGreaterEqual(len(planned), 5, "未实现的能力必须如实列出")
        self.assertEqual(len(verified) + len(planned), len(caps.CAPABILITIES))


if __name__ == "__main__":
    unittest.main(verbosity=2)
