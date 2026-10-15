"""最小 UIA 客户端：只读观测 + 语义输入（ValuePattern / InvokePattern）。

从 `spikes/local-workspace/uia.py` 抽出的最小子集，仍然自包含（不 import 原工程）。
vtable 槽位与 IID 沿用那份**已在真机验证过**的实现，顺序对应 Windows SDK 的
UIAutomationClient.h；没有把握的接口（如 TogglePattern）宁可不做，
复选框改用真实点击来表达，而不是靠猜 IID。

设计要点：
  * 进程里是 MTA；客户端**每次操作现建现关**，避免跨线程复用 COM 对象。
  * 每个元素都被 `owned()` 校验：进程属于本次 Job、会话一致、原生 HWND 在自有桌面上；
    密码控件一律拒绝。
  * 只提供只读读取与两种语义输入，不含焦点、系统键鼠、桌面切换。
"""
import copy
import ctypes as C
from ctypes import wintypes as W
import time
import uuid
from uia_identity import read_runtime_id

# UIA ControlType id（与 UIA_*ControlTypeId 一致），仅用于可读展示。
ROLE_NAMES = {
    50000: "Button", 50001: "Calendar", 50002: "CheckBox", 50003: "ComboBox",
    50004: "Edit", 50005: "Hyperlink", 50006: "Image", 50007: "ListItem",
    50008: "List", 50009: "Menu", 50010: "MenuBar", 50011: "MenuItem",
    50012: "ProgressBar", 50013: "RadioButton", 50014: "ScrollBar", 50015: "Slider",
    50016: "Spinner", 50017: "StatusBar", 50018: "Tab", 50019: "TabItem",
    50020: "Text", 50021: "ToolBar", 50022: "ToolTip", 50023: "Tree",
    50024: "TreeItem", 50025: "Custom", 50026: "Group", 50027: "Thumb",
    50028: "DataGrid", 50029: "DataItem", 50030: "Document", 50031: "SplitButton",
    50032: "Window", 50033: "Pane", 50034: "Header", 50035: "HeaderItem",
    50036: "Table", 50037: "TitleBar", 50038: "Separator",
}

UIA_VALUE_PATTERN_ID = 10002
IID_VALUE_PATTERN = "a94cd8b1-0844-4cd6-9d2d-640537ab39e9"
UIA_INVOKE_PATTERN_ID = 10000
IID_INVOKE_PATTERN = "fb377fbe-8ea6-46d5-9c73-6499642d3059"

MAX_ELEMENTS = 2000


class UiaError(RuntimeError):
    """UIA 调用失败；消息形如 uia-<reason> 或 uia-hresult-xxxxxxxx。"""


class GUID(C.Structure):
    _fields_ = [("bytes", C.c_ubyte * 16)]

    @classmethod
    def parse(cls, value):
        return cls.from_buffer_copy(uuid.UUID(value).bytes_le)


class Com:
    """裸 COM 接口指针的薄封装：按 vtable 槽位调用。"""

    def __init__(self, pointer):
        if not pointer:
            raise UiaError("uia-null-interface")
        self.pointer = C.c_void_p(pointer.value if isinstance(pointer, C.c_void_p) else pointer)

    def call(self, slot, args=(), values=()):
        table = C.cast(self.pointer, C.POINTER(C.POINTER(C.c_void_p))).contents
        method = getattr(C, "WINFUNCTYPE", C.CFUNCTYPE)(C.c_long, C.c_void_p, *args)(table[slot])
        result = method(self.pointer, *values)
        if result < 0:
            raise UiaError("uia-hresult-%08x" % (result & 0xFFFFFFFF))
        return result

    def close(self):
        if self.pointer:
            table = C.cast(self.pointer, C.POINTER(C.POINTER(C.c_void_p))).contents
            C.WINFUNCTYPE(C.c_ulong, C.c_void_p)(table[2])(self.pointer)
            self.pointer = None


class UiaTree:
    """绑定到某个自有窗口的 UIA 树；用 with 语句保证释放。"""

    def __init__(self, desktop, hwnd=None):
        self.desktop = desktop
        # 上一次 enumerate 结果：是否被预算截断、树里实际有多少元素。
        self.truncated = False
        self.available = 0
        self.ole = C.OleDLL("ole32")
        self.aut = C.OleDLL("oleaut32")
        self.ole.CoInitializeEx.argtypes = [C.c_void_p, W.DWORD]
        self.ole.CoInitializeEx.restype = C.c_long
        self.ole.CoCreateInstance.argtypes = [C.POINTER(GUID), C.c_void_p, W.DWORD,
                                              C.POINTER(GUID), C.POINTER(C.c_void_p)]
        self.ole.CoCreateInstance.restype = C.c_long
        self.aut.SysFreeString.argtypes = [C.c_void_p]
        self.aut.SysFreeString.restype = None

        if self.ole.CoInitializeEx(None, 0) < 0:      # COINIT_MULTITHREADED
            raise UiaError("uia-com-initialization-failed")

        self.client = self.root = self.condition = self.array = self.role_cache = None
        self.elements = []
        try:
            pointer = C.c_void_p()
            clsid = GUID.parse("e22ad333-b25f-460c-83d0-0581107395c9")   # CUIAutomation8
            iid = GUID.parse("34723aff-0c9d-49d0-9896-7ab52df8cd8a")     # IUIAutomation2
            if self.ole.CoCreateInstance(C.byref(clsid), None, 1, C.byref(iid),
                                        C.byref(pointer)) < 0:
                raise UiaError("uia-client-creation-failed")
            self.client = Com(pointer)
            self.client.call(59, (W.BOOL,), (False,))  # 禁止 pattern 隐式修改前台焦点。
            self.client.call(61, (W.DWORD,), (2000,))  # provider connection timeout
            self.client.call(63, (W.DWORD,), (5000,))  # provider transaction timeout

            pointer = C.c_void_p()
            self.client.call(20, (C.POINTER(C.c_void_p),), (C.byref(pointer),))
            self.role_cache = Com(pointer)
            for property_id in (30003,):
                self.role_cache.call(3, (C.c_int,), (property_id,))
            self.role_cache.call(7, (C.c_int,), (1,))   # 只缓存匹配元素，不缓存其子树。
            self.role_cache.call(11, (C.c_int,), (1,))  # Full，保留用于 live 归属复查的引用。

            if hwnd is None:
                windows = desktop.main_windows()
                if len(windows) != 1:
                    raise UiaError("uia-requires-unique-owned-window")
                hwnd = windows[0]
            self.hwnd = hwnd
            desktop.assert_target(hwnd)

            pointer = C.c_void_p()
            self.client.call(6, (W.HWND, C.POINTER(C.c_void_p)), (hwnd, C.byref(pointer)))
            self.root = Com(pointer)
            pointer = C.c_void_p()
            self.client.call(21, (C.POINTER(C.c_void_p),), (C.byref(pointer),))
            self.condition = Com(pointer)
            self.binding = self.window_binding()
        except BaseException:
            self.close()
            raise

    # -- 基础读取 ---------------------------------------------------------- #
    def _integer(self, element, slot):
        value = C.c_int()
        element.call(slot, (C.POINTER(C.c_int),), (C.byref(value),))
        return value.value

    def _string(self, element, slot):
        value = C.c_void_p()
        element.call(slot, (C.POINTER(C.c_void_p),), (C.byref(value),))
        try:
            return C.wstring_at(value) if value else ""
        except (ValueError, OSError):
            return ""
        finally:
            if value:
                self.aut.SysFreeString(value)

    def _owned(self, element, desktop_windows, *, cached=False):
        """元素必须属于本次 Job、同一会话，且其原生 HWND 归属自有窗口树。

        注意：`CurrentNativeWindowHandle` 对子控件返回的是**子窗口** HWND，
        而 `EnumDesktopWindows` 只枚举顶层窗口，所以不能直接用桌面枚举做成员证明。
        这里的判据是：同进程 + 其根祖先就是本次绑定的自有窗口（否则退化为"在自有桌面的顶层窗口里"）。
        """
        shift = 32 if cached else 0
        pid = self._integer(element, 20 + shift)
        if not pid or not self.desktop.api.process_in_job(pid, self.desktop.job) \
                or self.desktop.api.session(pid) != self.desktop.context["session"]:
            raise UiaError("uia-element-process-mismatch")
        if self._integer(element, 35 + shift):
            raise UiaError("uia-password-element-forbidden")
        native = self._integer(element, 36 + shift)
        if not native:
            return
        api = self.desktop.api
        if api.window_pid(native) != pid:
            raise UiaError("uia-native-window-process-mismatch")
        if api.u.GetAncestor(native, 2) == self.hwnd:      # GA_ROOT
            return
        if native not in desktop_windows:
            raise UiaError("uia-native-window-outside-workspace")

    # -- 只读观测 ---------------------------------------------------------- #
    def runtime_id(self, element):
        return read_runtime_id(self, element)

    def window_binding(self):
        self.desktop.assert_target(self.hwnd)
        context = self.desktop.context
        return {'desktop': context['desktop'], 'instanceId': context['instanceId'],
                'session': context['session'], 'hwnd': self.hwnd,
                'windowPid': self.desktop.api.window_pid(self.hwnd),
                'rootRuntimeId': self.runtime_id(self.root)}

    def prove_target(self, row):
        """在全局唯一筛选之后调用；RawWalker 只证明祖先归属，不用于选目标。"""
        return self._prove_element(row,False)

    def prove_container(self,row):
        """只读容器允许内容延伸出窗口；输入叶子仍须完整位于窗口内。"""
        if row['role'] not in (50026,50030,50033) or not row['autoId']:
            raise UiaError('learning-required:invalid-local-container')
        return self._prove_element(row,True)

    def _prove_element(self,row,container):
        if self.window_binding() != self.binding:
            raise UiaError('uia-target-identity-changed')
        element = self.elements[row['index']]
        windows = set(self.desktop.windows())
        self._owned(element, windows)
        if self._integer(element, 21) != row['role']:
            raise UiaError('uia-query-role-mismatch')
        if not self._integer(element, 28) or self._integer(element, 38):
            raise UiaError('uia-target-identity-changed')
        rid = self.runtime_id(element)
        if rid != row['runtimeId']:
            raise UiaError('uia-target-identity-changed')
        for key, slot in (('name', 23), ('autoId', 29), ('className', 30)):
            if self._string(element, slot) != row[key]:
                raise UiaError('uia-target-identity-changed')
        pointer = C.c_void_p()
        self.client.call(16, (C.POINTER(C.c_void_p),), (C.byref(pointer),))
        walker, parents = Com(pointer), []
        current = element
        try:
            for depth in range(17):
                if self.runtime_id(current) == self.binding['rootRuntimeId']:
                    break
                if depth == 16:
                    raise UiaError('uia-ancestry-unproven')
                pointer = C.c_void_p()
                walker.call(3, (C.c_void_p, C.POINTER(C.c_void_p)),
                            (current.pointer, C.byref(pointer)))
                if not pointer:
                    raise UiaError('uia-ancestry-unproven')
                current = Com(pointer)
                parents.append(current)
                self._owned(current, windows)
            if self.window_binding() != self.binding:
                raise UiaError('uia-target-identity-changed')
            rect = W.RECT()
            element.call(43, (C.POINTER(W.RECT),), (C.byref(rect),))
            row['rect'] = [rect.left, rect.top, rect.right, rect.bottom]
            left, top, right, bottom = row['rect']
            wl, wt, wr, wb = self.desktop.api.window_rect(self.hwnd)
            inside=(max(wl,left)<min(wr,right) and max(wt,top)<min(wb,bottom)) if container else \
                   (wl <= left < right <= wr and wt <= top < bottom <= wb)
            if not inside:
                raise UiaError('uia-ancestry-unproven')
            return {**self.binding, 'elementPid': self._integer(element, 20), 'runtimeId': rid,
                    'ancestorDepth': depth, 'strategy': 'full-tree',
                    'identityRebound': True}
        finally:
            for parent in parents:
                parent.close()
            walker.close()

    def _find_all(self, cached_roles=False):
        pointer = C.c_void_p()
        if cached_roles:
            # 批量获取轻量角色缓存，不让 provider 逐项评估昂贵的属性条件。
            self.root.call(8, (C.c_int, C.c_void_p, C.c_void_p, C.POINTER(C.c_void_p)),
                           (4, self.condition.pointer, self.role_cache.pointer, C.byref(pointer)))
        else:
            self.root.call(6, (C.c_int, C.c_void_p, C.POINTER(C.c_void_p)),
                           (4, self.condition.pointer, C.byref(pointer)))
        return Com(pointer)

    def _path_descriptor(self, element):
        rect=W.RECT()
        element.call(43,(C.POINTER(W.RECT),),(C.byref(rect),))
        wl,wt,_wr,_wb=self.desktop.api.window_rect(self.hwnd)
        box=[rect.left,rect.top,rect.right,rect.bottom]
        if box!=[0,0,0,0]:box=[box[0]-wl,box[1]-wt,box[2]-wl,box[3]-wt]
        return {'role':self._integer(element,21),'autoId':self._string(element,29),
                'className':self._string(element,30),'rect':box,
                'nativeAnchor':bool(self._integer(element,36))}

    def export_path(self, row):
        """从刚刚独立核验的目标导出 Raw 祖先路径；坐标只作身份的组合约束。"""
        self.prove_target(row)
        pointer=C.c_void_p();self.client.call(16,(C.POINTER(C.c_void_p),),(C.byref(pointer),))
        walker,parents=Com(pointer),[]
        current=self.elements[row['index']];path=[]
        try:
            for depth in range(17):
                if self.runtime_id(current)==self.binding['rootRuntimeId']:return list(reversed(path))
                if depth==16:raise UiaError('uia-ancestry-unproven')
                descriptor=self._path_descriptor(current)
                if descriptor['nativeAnchor']:descriptor['autoId']=''  # 原生宿主的 ID 可能由当前 HWND 派生。
                path.append(descriptor)
                pointer=C.c_void_p()
                walker.call(3,(C.c_void_p,C.POINTER(C.c_void_p)),(current.pointer,C.byref(pointer)))
                if not pointer:raise UiaError('uia-ancestry-unproven')
                current=Com(pointer);parents.append(current)
            raise UiaError('uia-ancestry-unproven')
        finally:
            for parent in parents:parent.close()
            walker.close()

    def rebind_paths(self, paths, budget=256, max_depth=16):
        """沿已学身份路径查找所有候选，不按数组下标选择，不退回全树。"""
        if not isinstance(paths,list) or not 1<=len(paths)<=8:
            raise UiaError('learning-required:invalid-target-path')
        for path in paths:
            if not isinstance(path,list) or not 1<=len(path)<=max_depth:
                raise UiaError('learning-required:invalid-target-path-depth')
            for hop in path:
                if not isinstance(hop,dict) or set(hop) not in ({'role','autoId','className','rect'}, {'role','autoId','className','rect','nativeAnchor'}) \
                        or ('nativeAnchor' in hop and type(hop['nativeAnchor']) is not bool) \
                        or type(hop['role']) is not int or not all(isinstance(hop[k],str) and len(hop[k])<=512 for k in ('autoId','className')) \
                        or not isinstance(hop['rect'],list) or len(hop['rect'])!=4 \
                        or not all(type(v) in (int,float) and -4096<=v<=4096 for v in hop['rect']):
                    raise UiaError('learning-required:invalid-target-path-hop')
        self.desktop.api.capture_dpi()
        if self.window_binding()!=self.binding:raise UiaError('uia-target-identity-changed')
        self._release_elements()
        self.local_stats={'visited':0,'fullTreeQuery':False,'strategy':'learned-raw-identity-paths'}
        pointer=C.c_void_p();self.client.call(16,(C.POINTER(C.c_void_p),),(C.byref(pointer),))
        walker,windows,result,seen=Com(pointer),set(self.desktop.windows()),[],set()
        def walk(parent,path,depth):
            children,current,slot=[],parent,4
            try:
                while True:
                    pointer=C.c_void_p()
                    walker.call(slot,(C.c_void_p,C.POINTER(C.c_void_p)),(current.pointer,C.byref(pointer)))
                    if not pointer:break
                    current,slot=Com(pointer),6;children.append(current)
                    self.local_stats['visited']+=1
                    if self.local_stats['visited']>budget:raise UiaError('learning-required:local-query-budget')
                for i,element in enumerate(children):
                    self._owned(element,windows)
                    actual=self._path_descriptor(element);expected=path[depth]
                    a,e=actual['rect'],expected['rect']
                    same_area=(a==e==[0,0,0,0]) or (a!=[0,0,0,0] and e!=[0,0,0,0]
                        and max(a[0],e[0])<min(a[2],e[2]) and max(a[1],e[1])<min(a[3],e[3]))
                    same_id=(actual['nativeAnchor'] if expected.get('nativeAnchor') else actual['autoId']==expected['autoId'])
                    if any(actual[k]!=expected[k] for k in ('role','className')) or not same_id or not same_area:continue
                    if depth+1<len(path):walk(element,path,depth+1);continue
                    rid=self.runtime_id(element);key=tuple(rid)
                    if key in seen:continue
                    seen.add(key);self.elements.append(element);children[i]=None
                    rect=W.RECT();element.call(43,(C.POINTER(W.RECT),),(C.byref(rect),))
                    result.append({'index':len(self.elements)-1,'role':actual['role'],
                        'roleName':ROLE_NAMES.get(actual['role'],str(actual['role'])),
                        'autoId':actual['autoId'],'className':actual['className'],
                        'name':self._string(element,23),'enabled':bool(self._integer(element,28)),
                        'offscreen':bool(self._integer(element,38)),'native':self._integer(element,36),
                        'runtimeId':rid,'rect':[rect.left,rect.top,rect.right,rect.bottom]})
            finally:
                for element in children:
                    if element:element.close()
        try:
            for path in paths:walk(self.root,path,0)
            if self.window_binding()!=self.binding:raise UiaError('uia-target-identity-changed')
            self.truncated=False;self.available=len(result)
            return result
        except BaseException:
            self._release_elements();raise
        finally:walker.close()

    def container_rows(self, path, region, budget=256, max_depth=16):
        """复用已学容器路径，只读取该容器与声明可见区域的交集。容器不作为输入目标。"""
        started=time.perf_counter()
        saved=getattr(self,'local_container',None)
        if saved and saved['path']==path:
            row=copy.deepcopy(saved['row'])
            self.prove_container(row)  # 引用仅寻址，重新读取身份、祖先、布局和归属。
            self.local_stats={'visited':0,'fullTreeQuery':False,'strategy':'bound-container-fresh-local-query',
                              'containerId':row['autoId'],'containerUnique':True,'reusedContainer':True}
            bound=time.perf_counter()
            rows=self.local_rows(region,budget,max_depth,scope_root=self.elements[row['index']])
            self.local_stats.update(containerIdentityMs=round((bound-started)*1000,3),
                                    containerReadMs=round((time.perf_counter()-bound)*1000,3))
            return rows
        roots=self.rebind_paths([path],budget,max_depth)
        if not roots:raise UiaError('learning-required:local-container-not-found')
        if len(roots)!=1:raise UiaError('learning-required:local-container-not-unique')
        row=roots[0]
        if row['role'] not in (50026,50030,50033) or not row['autoId']:
            raise UiaError('learning-required:invalid-local-container')
        self.local_stats.update(strategy='learned-container-local-query',containerId=row['autoId'],
                                containerPathDepth=len(path),containerUnique=True)
        self.local_container={'path':copy.deepcopy(path),'row':copy.deepcopy(row)}
        bound=time.perf_counter()
        rows=self.local_rows(region,budget,max_depth,scope_root=self.elements[row['index']])
        self.local_stats.update(pathRebindMs=round((bound-started)*1000,3),
                                containerReadMs=round((time.perf_counter()-bound)*1000,3))
        return rows

    def retain_local_container(self):
        """页面切换只保留已绑定容器的寻址引用；丢弃全部旧叶子观察。"""
        saved=getattr(self,'local_container',None)
        if not saved:raise UiaError('learning-required:missing-local-container-binding')
        root=self.elements[saved['row']['index']]
        for element in self.elements:
            if element is not root:element.close()
        self.elements=[root];saved['row']['index']=0

    def local_rows(self, region, budget=256, max_depth=16, *, scope_root=None):
        """固定布局声明的可见祖先包围区域；Control View Children 有界遍历，无 FindAll。

        这是显式局部范围，不能当作整个窗口的全局唯一性证明。零矩形包装层继续
        遍历；可见且不相交的祖先分支按学习配置裁除。超预算/深度明确失败。
        """
        from replay_observation import validate_match
        validate_match({'role': 50004, 'anyName': True, 'region': region})
        if region is None or not 1 <= budget <= 256 or not 1 <= max_depth <= 16:
            raise UiaError('learning-required:invalid-local-scope')
        self.desktop.api.capture_dpi()
        if self.window_binding() != self.binding:
            raise UiaError('learning-required:instance-changed')
        if scope_root is None:
            self._release_elements()
        elif scope_root not in self.elements:
            raise UiaError('learning-required:invalid-local-container-binding')
        wl, wt, wr, wb = self.desktop.api.window_rect(self.hwnd)
        bounds = [wl+region[0]*(wr-wl), wt+region[1]*(wb-wt),
                  wl+region[2]*(wr-wl), wt+region[3]*(wb-wt)]
        windows, result = set(self.desktop.windows()), []
        if scope_root is None:
            self.local_stats = {'visited': 0, 'fullTreeQuery': False}
        self.local_stats.update(prunedBranches=0,scopePolicy='control-view-visible-ancestor-containment')
        # 每层现场批量获取直接子节点；不复用上一轮快照，不抓取整棵子树，
        # 不减少候选覆盖。输入目标仍由 prove_target 独立读取 Current 属性。
        cache_pointer = C.c_void_p()
        self.client.call(20, (C.POINTER(C.c_void_p),), (C.byref(cache_pointer),))
        cache = Com(cache_pointer)
        try:
            for property_id in (30001,30002,30003,30005,30010,30011,30012,30019,30020,30022):
                cache.call(3, (C.c_int,), (property_id,))
            cache.call(7, (C.c_int,), (2,))   # TreeScope_Children；不递归抓取后代
            cache.call(11, (C.c_int,), (1,))  # Full: 保留现场核验及输入能力
            view_pointer=C.c_void_p()
            self.client.call(18,(C.POINTER(C.c_void_p),),(C.byref(view_pointer),))
            view=Com(view_pointer)
            try:cache.call(9,(C.c_void_p,),(view.pointer,))  # 显式 Control View
            finally:view.close()
        except BaseException:
            cache.close()
            raise
        self.local_stats.update(propertyReadStrategy='fresh-control-view-children-batch',cachedProperties=10,
                                childrenBatchCalls=0,childrenBatchMs=0.)
        projected_roles=getattr(self,'local_projection_roles',None)
        if projected_roles is not None:self.local_stats['projectedRoles']=sorted(projected_roles)
        def walk(parent, depth):
            children, snapshot, array = [], None, None
            try:
                started=time.perf_counter()
                pointer=C.c_void_p()
                parent.call(9,(C.c_void_p,C.POINTER(C.c_void_p)),(cache.pointer,C.byref(pointer)))  # BuildUpdatedCache
                snapshot=Com(pointer)
                pointer=C.c_void_p()
                snapshot.call(19,(C.POINTER(C.c_void_p),),(C.byref(pointer),))  # GetCachedChildren
                self.local_stats['childrenBatchCalls']+=1
                self.local_stats['childrenBatchMs']+=round((time.perf_counter()-started)*1000,3)
                if not pointer:return
                array=Com(pointer)
                count=self._integer(array,3)
                if count<0:raise UiaError('uia-invalid-children-count')
                self.local_stats['visited']+=count
                if self.local_stats['visited']>budget:
                    raise UiaError('learning-required:local-query-budget')
                for index in range(count):
                    pointer=C.c_void_p()
                    array.call(4,(C.c_int,C.POINTER(C.c_void_p)),(index,C.byref(pointer)))
                    children.append(Com(pointer))
                for i, element in enumerate(children):
                    self._owned(element, windows, cached=True)
                    rect = W.RECT()
                    element.call(75, (C.POINTER(W.RECT),), (C.byref(rect),))
                    box = [rect.left, rect.top, rect.right, rect.bottom]
                    zero = box == [0, 0, 0, 0]
                    outside = box[2] <= bounds[0] or box[0] >= bounds[2] \
                        or box[3] <= bounds[1] or box[1] >= bounds[3]
                    offscreen = bool(self._integer(element, 70))
                    if not zero and (outside or offscreen):
                        self.local_stats['prunedBranches'] += 1
                        continue
                    if depth > max_depth:
                        raise UiaError('learning-required:local-query-depth:role=%s:name=%s:rect=%s' % (
                            self._integer(element, 53), self._string(element, 55)[:100], box))
                    self.elements.append(element)
                    children[i] = None
                    if not zero:
                        role = self._integer(element, 53)
                        if projected_roles is None or role in projected_roles:
                            result.append({'index': len(self.elements)-1, 'role': role,
                                'roleName': ROLE_NAMES.get(role, str(role)), 'name': self._string(element, 55),
                                'autoId': self._string(element, 61), 'className': self._string(element, 62),
                                'enabled': bool(self._integer(element, 60)), 'offscreen': offscreen,
                                'native': self._integer(element, 68), 'runtimeId': None, 'rect': box})
                    walk(element, depth+1)
            finally:
                for element in children:
                    if element:
                        element.close()
                if array:array.close()
                if snapshot:snapshot.close()
        try:
            walk(scope_root if scope_root is not None else self.root, 1)
            if self.window_binding() != self.binding:
                raise UiaError('learning-required:instance-changed')
            self.truncated = False
            self.available = len(result)
            return result
        except BaseException as error:
            error.observation={'complete':False,'localStatistics':copy.deepcopy(self.local_stats),
                'visibleContext':[{'role':r['role'],'name':r['name'],'autoId':r['autoId'],'rect':r['rect']}
                                  for r in result if r['name'] or r['autoId']][:100]}
            self._release_elements()
            raise
        finally:
            cache.close()

    def enumerate(self, roles=None, budget=None, settle=True, identities=True):
        """枚举后代控件。roles 为 None 表示全部；否则批量缓存角色后筛选，仅向匹配项读取当前详细属性。

        available / truncated 始终描述自有根下的候选范围，保留原来的预算语义。
        角色标签来自本次批量快照；详细属性和归属使用 live 读取，不用 FindFirst、不复用旧元素。

        **超出预算时截断而不是报错**：真实 CEF 应用在窗口定尺后会展开出数百个元素
        （实测 627 个），直接失败会把"树太大"变成"能力不可用"。截断后由 `truncated`
        标记，调用方据此区分"确实没有这个控件"和"没枚举完，不能下结论"。
        每个元素要读 6 个 COM 属性，所以这一步很贵（实测 627 个约 11 秒）。

        全树观察的 `settle=True` 会先用"只数不读"的方式等树稳定：实测同一个窗口第一次查询得到 64 个，
        随后变成 627 个——**查询本身会触发应用异步构建无障碍树**，第一次的结果不完整，
        直接拿它判定"控件不存在"会误报。数长度不读属性，代价远低于重复枚举。
        """
        limit = MAX_ELEMENTS if budget is None else min(MAX_ELEMENTS, max(0, int(budget)))
        roles = None if roles is None else set(roles)
        if roles is not None and any(type(role) is not int or role not in ROLE_NAMES for role in roles):
            raise UiaError("uia-unsupported-role")
        self.desktop.assert_target(self.hwnd)
        desktop_windows = set(self.desktop.windows())   # 每次枚举只取一次
        self._release_elements()
        self.truncated = False
        self.available = 0
        array = None
        result = []
        started = time.perf_counter()
        self.timings = {}
        try:
            array = self._find_all(cached_roles=roles is not None)
            after_find = time.perf_counter()
            count = self._integer(array, 3)
            after_count = time.perf_counter()
            self.timings["nativeFindMs"] = round((after_find - started) * 1000, 3)
            self.timings["arrayCountMs"] = round((after_count - after_find) * 1000, 3)
            # 角色查询直接返回一次完整快照；不再先做两轮昂贵的全树数量探测。
            # 独立核验及后续动作会分别重新查询，不把本次结果当成应用永久稳定的承诺。
            if settle and roles is None:
                for _ in range(4):
                    time.sleep(0.25)
                    probe = self._find_all()
                    grown = self._integer(probe, 3)
                    if grown <= count:
                        probe.close()
                        break
                    array.close()
                    array, count = probe, grown
            query_ms = round((time.perf_counter() - started) * 1000)
            self.timings["settleMs"] = query_ms if roles is None else 0
            self.timings["roleCacheMs"] = query_ms if roles is not None else 0
            detailed = time.perf_counter()
            self.available = count
            self.truncated = count > limit
            for index in range(min(count, limit)):
                item = C.c_void_p()
                array.call(4, (C.c_int, C.POINTER(C.c_void_p)), (index, C.byref(item)))
                element = Com(item)
                self.elements.append(element)
                role = self._integer(element, 53 if roles is not None else 21)
                if roles is not None and role not in roles:
                    self.elements.pop().close()
                    continue
                if roles is not None and self._integer(element, 21) != role:
                    raise UiaError("uia-query-role-mismatch")
                self._owned(element, desktop_windows)
                rect = W.RECT()
                element.call(43, (C.POINTER(W.RECT),), (C.byref(rect),))
                result.append({
                    "index": len(self.elements) - 1,
                    "role": role, "roleName": ROLE_NAMES.get(role, str(role)),
                    "name": self._string(element, 23),
                    "autoId": self._string(element, 29),
                    "className": self._string(element, 30),
                    "enabled": bool(self._integer(element, 28)),
                    "offscreen": bool(self._integer(element, 38)),
                    "native": self._integer(element, 36),
                    "runtimeId": self.runtime_id(element) if identities else None,
                    "rect": [rect.left, rect.top, rect.right, rect.bottom],
                })
            self.desktop.assert_target(self.hwnd)
            self.timings["readMs"] = round((time.perf_counter() - detailed) * 1000)
            return result
        except BaseException:
            self._release_elements()
            raise
        finally:
            if array:
                array.close()

    def _pattern(self, index, pattern_id, iid):
        element = self.elements[index]
        self._owned(element, set(self.desktop.windows()))
        self.desktop.assert_target(self.hwnd)
        pointer, guid = C.c_void_p(), GUID.parse(iid)
        element.call(14, (C.c_int, C.POINTER(GUID), C.POINTER(C.c_void_p)),
                     (pattern_id, C.byref(guid), C.byref(pointer)))
        return Com(pointer)

    def value(self, index):
        pattern = self._pattern(index, UIA_VALUE_PATTERN_ID, IID_VALUE_PATTERN)
        try:
            return self._string(pattern, 4)
        finally:
            pattern.close()

    # -- 语义输入 ---------------------------------------------------------- #
    def set_value(self, index, text, timeout=1.5):
        """ValuePattern.SetValue，并读回校验；不通过就报错，不靠"应该生效了"。"""
        pattern = self._pattern(index, UIA_VALUE_PATTERN_ID, IID_VALUE_PATTERN)
        try:
            self.desktop.assert_target(self.hwnd)
            pattern.call(3, (W.LPCWSTR,), (text,))
            unit = self.desktop.clock() + timeout
            while self._string(pattern, 4) != text:
                self.desktop.assert_target(self.hwnd)
                if self.desktop.clock() >= unit:
                    raise UiaError("uia-value-effect-mismatch")
                time.sleep(0.05)
        finally:
            pattern.close()

    def invoke(self, index):
        """InvokePattern.Invoke。取不到就明确失败，不退化成物理点击。"""
        pattern = self._pattern(index, UIA_INVOKE_PATTERN_ID, IID_INVOKE_PATTERN)
        try:
            self.desktop.assert_target(self.hwnd)
            pattern.call(3)
        finally:
            pattern.close()

    # -- 释放 -------------------------------------------------------------- #
    def _release_elements(self):
        for element in self.elements:
            element.close()
        self.elements = []

    def close(self):
        self._release_elements()
        for item in (self.array, self.role_cache, self.condition, self.root, self.client):
            if item:
                item.close()
        self.array = self.role_cache = self.condition = self.root = self.client = None
        try:
            self.ole.CoUninitialize()
        except OSError:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
        return False
