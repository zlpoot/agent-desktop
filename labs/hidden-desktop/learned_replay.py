"""JSON 学习记录 + 共用执行器。COM 只在一个专用 MTA 线程存活，不写入 JSON。

基础学习保留完整查询；固定布局回放使用局部发现及实例内目标绑定。
回放核验原目标的实时身份/归属/几何和实际结果，
不把绑定时唯一性当作新的全局唯一证明。任何失败都停止，不自动学习或重放。
"""
import copy
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import time
import uuid

from capabilities import CapabilityError
from hidden_desktop import Blocked
from uia_client import ROLE_NAMES, UiaTree, UiaError
from replay_observation import PageObservation
from skill_composition import binding_contract, substitute
from local_replay import LocalBindings, validate_local_profile
from learned_paths import LearnedPaths
from replay_contract import (
    RelearnRequired, ReplayError, TargetQueryError, fingerprint, load_recipe, validate_recipe,
)


def live_target(tree, row, specification):
    """旧引用只用于寻址；属性、归属、祖先、几何和结果全部现场读取。"""
    row = copy.deepcopy(row)
    element = tree.elements[row['index']]
    current_name = tree._string(element, 23)
    if specification['namePolicy'] == 'dynamic':
        row['name'] = current_name
    elif current_name != row['name']:
        raise ReplayError('bound-target-changed')
    proof = tree.prove_target(row)
    row['native'] = tree._integer(element, 36)
    row['identity'] = {**proof, 'strategy': 'bound-target-live-checks',
                       'globalUnique': None, 'uniqueness': 'proven-at-binding-only',
                       'evidence': 'current-properties-and-ancestry'}
    return row


class LearnedReplay:
    def __init__(self, lab, lock, template_path, learned_path, publish_preview,
                 tree_factory=UiaTree, fingerprint_fn=fingerprint, library=None, job_path=None, paths_path=None):
        self.lab, self.host_lock = lab, lock
        self.template_path, self.learned_path = Path(template_path), Path(learned_path)
        self.publish_preview = publish_preview
        self.tree_factory, self.fingerprint = tree_factory, fingerprint_fn
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='learned-uia')
        self.state_lock = threading.RLock()
        self.job = None
        self.bound = {}
        self.binding = None
        self.active_recipe = None
        self.values = {}
        self.requires_reset = False
        self.library = library
        self.current_step = None
        self.local_bindings = None
        self.job_path = Path(job_path) if job_path else None
        self.finalizing = False
        self.paths_path=Path(paths_path) if paths_path else None
        self.path_store=None
        self.learning_paths=False
        self.paths_contract_checked=False
        if self.job_path and self.job_path.is_file() and self.job_path.stat().st_size <= 4194304:
            try:
                previous = json.loads(self.job_path.read_text(encoding='utf-8'))
                if isinstance(previous, dict) and isinstance(previous.get('id'), str) \
                        and previous.get('status') in ('done', 'failed'):
                    self.job = previous  # 仅恢复记录；绝不恢复 COM、输入状态或自动重发动作。
            except (OSError, ValueError):
                pass

    def busy(self):
        with self.state_lock:
            return self.finalizing or bool(self.job and self.job['status'] == 'running')

    def summary(self):
        template = load_recipe(self.template_path)
        try:
            recipe, reason = load_recipe(self.learned_path, True), None
        except (ReplayError, OSError) as error:
            recipe, reason = None, str(error)
        with self.state_lock:
            saved_operations = {o['id']: o for o in recipe['operations']} if recipe else {}
            unlearned = [o['id'] for o in template['operations'] if o.get('learningRequired')
                         and (saved_operations.get(o['id']) != o or not recipe
                              or o['id'] not in recipe['learning'].get('verifiedOperations', {}))]
            return {'definition': template, 'recipe': recipe, 'learningRequired': recipe is None,
                    'unlearnedOperations': unlearned,
                    'reason': reason, 'bound': bool(self.binding), 'requiresReset': self.requires_reset,
                    'values': copy.deepcopy(self.values), 'busy': self.busy()}

    def status(self, job_id):
        with self.state_lock:
            if not self.job or job_id not in (self.job['id'], 'latest'):
                raise ReplayError('job-not-found')
            return copy.deepcopy(self.job)

    def start(self, action, inputs=None):
        with self.state_lock:
            if self.busy():
                raise ReplayError('replay-busy')
            self.job = {'id': uuid.uuid4().hex, 'action': action, 'status': 'running',
                        'inputs': inputs or {}, 'calls': [], 'startedAt': time.time(),
                        'verification': {'status': '执行中'}}
            job_id = self.job['id']
        self.executor.submit(self._execute, action, inputs or {})
        return job_id

    def trace(self, name, args, fn):
        entry = {'capability': name, 'arguments': copy.deepcopy(args), 'status': '执行中',
                 'startedAt': time.time()}
        if self.current_step is not None:
            entry['workflowStep'] = self.current_step
        with self.state_lock:
            self.job['calls'].append(entry)
        started = time.perf_counter()
        try:
            result = fn()
            with self.state_lock:
                entry.update(status='调用成功', result=copy.deepcopy(result))
            return result
        except Exception as error:
            with self.state_lock:
                entry.update(status='失败／效果须核对', error=str(error))
                if getattr(error,'observation',None):entry['observation']=copy.deepcopy(error.observation)
            raise
        finally:
            with self.state_lock:
                entry.update(elapsedMs=round((time.perf_counter() - started) * 1000, 3), finishedAt=time.time())

    def invoke(self, name, args=None):
        return self.trace(name, args or {}, lambda: self.lab.invoke(name, args or {})['result'])

    def _drop(self, preserve_containers=False):
        # 此函数始终在专用 COM 线程运行；先释放元素/客户端，再 CoUninitialize。
        errors = []
        trees = [tree for tree, _row in self.bound.values()]
        if self.local_bindings:
            if preserve_containers:
                closed=self.local_bindings.reset_page()
                kept={id(tree) for tree in self.local_bindings.trees()}
                trees=[tree for tree in trees if id(tree) not in kept|closed]
            else:trees.extend(self.local_bindings.trees())
        seen = set()
        for tree in trees:
            if id(tree) in seen:
                continue
            seen.add(id(tree))
            try:
                tree.close()
            except Exception as error:
                errors.append(str(error))
        with self.state_lock:
            self.bound = {}
            self.binding = None
            self.active_recipe = None
            self.values = {}
            if not preserve_containers:self.local_bindings = None
        if errors:
            raise ReplayError('binding-release-failed:' + ';'.join(errors))

    def invalidate(self):
        """调用方持有 host_lock，且已确认没有排队/运行中的回放任务。"""
        self.executor.submit(self._drop).result()

    def shutdown(self):
        self.executor.submit(self._drop).result()
        self.executor.shutdown(wait=True)

    def _window(self, recipe, startup=False):
        selector = recipe['environment']['window']
        candidates = []
        for attempt in range(30 if startup else 1):
            observed = self.invoke('observe.window.enumerate')
            candidates = [w for w in observed['items'] if w['owned'] and w['root']
                          and w['className'] == selector['value']]
            if len(candidates) > 1:
                raise ReplayError('window-not-unique')
            if candidates:
                break
            if startup:
                time.sleep(1)
        if len(candidates) != 1:
            raise ReplayError('window-not-found')
        selected = self.invoke('locate.window', selector)
        if selected['target'] != candidates[0]['hwnd']:
            raise ReplayError('window-changed')
        return self._environment(recipe)

    def _environment(self, recipe):
        def mismatch(code):
            if recipe.get('localReplay'):
                raise RelearnRequired('learning-required:' + code)
            raise ReplayError(code)
        desktop, hwnd = self.lab._target_window()
        identity = self.lab._do_verify_target_identity({})
        if not identity['ok'] or not identity['alive']:
            mismatch('environment-identity-failed')
        if os.path.normcase(os.path.abspath(identity['image'])) != os.path.normcase(os.path.abspath(recipe['application']['executable'])):
            mismatch('application-mismatch')
        if desktop.api.window_class(hwnd) != recipe['environment']['window']['value']:
            mismatch('window-class-changed')
        current = {k: identity[k] for k in ('pid', 'session', 'instanceId', 'desktopName')}
        current['hwnd'] = hwnd
        if self.binding is not None and current != self.binding:
            mismatch('instance-changed-rebind-required')
        fp = self.fingerprint(recipe['application']['executable'])
        expected = recipe.get('learning', {}).get('applicationFingerprint')
        if expected is not None and fp != expected:
            mismatch('application-version-changed-learning-required')
        if recipe.get('localReplay'):
            desktop.api.capture_dpi()
            l, t, r, b = desktop.api.window_rect(hwnd)
            layout = validate_local_profile(recipe)['layout']
            if (r-l, b-t) != (layout['width'], layout['height']):
                raise RelearnRequired('learning-required:window-layout-mismatch')
        return desktop, hwnd, current, fp

    def _prepare_local_window(self, recipe, window_recipe, reuse=False):
        """启动阶段先等待真实渲染/几何稳定，再定尺；不查询 UIA 或重发任务输入。"""
        if reuse:
            desktop,hwnd,_identity,_fp=self._environment(window_recipe)
            rect=desktop.api.window_rect(hwnd)
            if [rect[2]-rect[0],rect[3]-rect[1]]==[recipe['environment']['size'][k] for k in ('width','height')]:
                def reuse_layout():
                    self._environment(recipe)
                    frame,_image=desktop.capture_frame(hwnd)
                    if frame.get('unrendered') or desktop.api.window_rect(hwnd)!=rect:
                        raise ReplayError('reused-window-not-stable')
                    return {'reusedOwnedWindow':True,'rendered':True,'rect':rect}
                self.trace('replay.window.reuse_layout',{},reuse_layout)
                return
        def await_surface():
            deadline, previous, stable_since, samples = time.monotonic()+15, None, None, 0
            while time.monotonic() < deadline:
                desktop, hwnd, identity, _fp = self._environment(window_recipe)
                desktop.api.capture_dpi()
                rect = desktop.api.window_rect(hwnd)
                try:
                    frame, _image = desktop.capture_frame(hwnd)
                except Blocked as error:
                    if str(error) != 'preview_unrendered':
                        raise
                    previous, stable_since = None, None
                else:
                    samples += 1
                    stamp = (identity, rect)
                    if stamp != previous:
                        previous, stable_since = stamp, time.monotonic()
                    elif time.monotonic()-stable_since >= .6:
                        return {'rendered': True, 'rect': rect, 'samples': samples}
                time.sleep(.2)
            raise ReplayError('startup-window-not-stable')
        self.trace('replay.window.await_surface', {'timeoutSeconds':15,'stableSeconds':.6}, await_surface)
        self.invoke('act.window.fit', recipe['environment']['size'])
        self.trace('replay.window.await_layout', {'stableSeconds':.6}, await_surface)
        self._environment(recipe)

    def _local_query(self, recipe, spec, minimum=1, maximum=1, template=None):
        profile = validate_local_profile(recipe)
        desktop, hwnd, identity, fp = self._environment(recipe)
        if self.paths_path and not self.paths_contract_checked:
            self.path_store=LearnedPaths(self.paths_path,learning=self.learning_paths)
            self.path_store.begin(fp,profile,self.learning_paths)
            self.paths_contract_checked=True
        if self.local_bindings is None:
            self.local_bindings = LocalBindings(profile, identity)
        if self.local_bindings.profile != profile:
            raise RelearnRequired('learning-required:local-profile-changed')
        try:
            paths=self.path_store.get(template or spec) if self.path_store and not self.learning_paths else None
            tree,proof=self.local_bindings.query(spec, minimum, maximum,
                lambda: self.tree_factory(desktop, hwnd), identity,paths=paths,
                capture_paths=bool(self.path_store and self.learning_paths))
            if self.path_store and self.learning_paths and proof.get('learnedPaths'):
                self.path_store.record(template or spec,proof.pop('learnedPaths'))
            return tree,proof
        except TargetQueryError:
            raise
        except (UiaError, ValueError) as error:
            failure=RelearnRequired('learning-required:local-target-invalid:' + str(error))
            if getattr(error,'observation',None):failure.observation=error.observation
            raise failure from error

    def _bind_local(self, recipe):
        validate_local_profile(recipe)
        _desktop, _hwnd, identity, _fp = self._environment(recipe)
        for key, spec in recipe['targets'].items():
            selector = spec['selector']
            role = next((value for value, name in ROLE_NAMES.items() if name == selector.get('role')), None)
            if role is None or selector.get('kind') != 'role':
                raise RelearnRequired('learning-required:unsupported-local-selector')
            match = {'role': role, 'region': spec['probeRegion']}
            if selector['value']:
                match['name'] = selector['value']
            else:
                match['anyName'] = True
            tree, proof = self._traced_local_query(recipe, match, purpose='bind:' + key)
            row = proof['matches'][0]
            learned = recipe.get('learning', {}).get('targets', {}).get(key)
            keys = ['role', 'autoId', 'className'] + (['name'] if spec['namePolicy'] == 'exact' else [])
            if not isinstance(learned, dict) or any(field not in learned or row[field] != learned[field] for field in keys):
                raise RelearnRequired('learning-required:learned-target-parameters-changed:' + key)
            self.bound[key] = (tree, row)
        self.binding, self.active_recipe = identity, copy.deepcopy(recipe)
        return {'fullQueries': 0, 'strategy': 'bound-targets-local-probes', 'binding': identity}

    def _traced_local_query(self, recipe, spec, minimum=1, maximum=1, purpose='verify', template=None):
        tree = None
        def query():
            nonlocal tree
            tree, proof = self._local_query(recipe, spec, minimum, maximum, template=template)
            return proof
        proof = self.trace('replay.local.read', {'match': spec, 'min': minimum, 'max': maximum,
            'purpose': purpose, 'queryTemplate':template, 'fullTreeQuery': False}, query)
        return tree, proof

    def _ensure_control_state(self, step, tree, original_row, *, local=True):
        def read_state():
            row = copy.deepcopy(original_row)
            row['name'] = tree._string(tree.elements[row['index']], 23)
            if row['name'] not in (step['desiredName'], step['actionName']):
                if local:
                    raise RelearnRequired('learning-required:unexpected-control-state')
                raise ReplayError('unexpected-control-state')
            tree.prove_target(row)
            return row
        row = self.trace('replay.state.read', step, read_state)
        if row['name'] == step['desiredName']:
            return
        if self.lab.actions >= self.lab.max_actions:
            raise ReplayError('budget-exhausted')
        handle = row['native'] or tree.hwnd
        l, t, r, b = row['rect']
        x, y = tree.desktop.api.screen_to_client(handle, (l+r)//2, (t+b)//2)
        self.lab.actions += 1
        receipt = self.trace('replay.state.click', step, lambda: tree.desktop.click(handle, x, y, double=False))
        if not receipt.get('dispatched'):
            raise ReplayError('click-effect-unknown')
        deadline = time.monotonic()+1.5
        while True:
            current = self.trace('replay.state.read', step, read_state)
            if current['name'] == step['desiredName']:
                return
            if time.monotonic() >= deadline:
                raise ReplayError('control-state-not-confirmed')
            time.sleep(.05)

    def _local_operation(self, recipe, operation):
        validate_local_profile(recipe)
        if operation['steps'][0].get('newPageBindings'):
            retain=operation['steps'][0].get('retainContainerBindings',False)
            self.trace('replay.binding.page_reset',{'reason':'declared-page-transition','retainContainerAddressOnly':retain},
                       lambda:self._drop(preserve_containers=retain))
        result = {'fullQueries': 0, 'localQueries': 0, 'reusedReads': 0, 'checks': []}
        retained, original_identity, pending_ready = {}, None, None
        for step in operation['steps']:
            ready,pending_ready=pending_ready,None
            desktop, hwnd, identity, _fp = self._environment(recipe)
            if original_identity is not None and identity != original_identity:
                raise RelearnRequired('learning-required:instance-changed')
            original_identity = identity
            op = step['op']
            if op in ('observe_page', 'observe_local'):
                self.trace('replay.local.ready', {'fullTreeQuery': False},
                           lambda: {'strategy': 'bound-targets-local-probes', 'independentLiveReads': True})
                if step.get('readyMatch'):
                    ready_started=time.monotonic()
                    deadline=ready_started+step['timeoutMs']/1000
                    attempts=0
                    while True:
                        try:
                            attempts+=1
                            ready_tree,ready_proof=self._traced_local_query(recipe,step['readyMatch'],purpose='await-declared-page-ready',
                                                     template=step.get('_readyMatchTemplate'))
                            pending_ready=(step['readyMatch'],ready_tree,ready_proof)
                            self.trace('replay.ready.receipt',{'match':step['readyMatch']},
                                lambda:{'attempts':attempts,'elapsedMs':round((time.monotonic()-ready_started)*1000,3),
                                        'inputRetried':False,'fixedDelayMs':0})
                            break
                        except (RelearnRequired,TargetQueryError) as error:
                            if not any(code in str(error) for code in ('page-match-count:0:','local-container-not-found')) \
                                    or time.monotonic()>=deadline:raise
                            time.sleep(.1)  # 只重读声明中的页面就绪条件，不重发输入或更换定位方式。
            elif op in ('assert_rows', 'click_match', 'click_if_present', 'bind_match'):
                if ready and op in ('assert_rows','click_match') and ready[0]==step['match'] \
                        and step.get('min',1)==step.get('max',1)==1:
                    tree,proof=ready[1],copy.deepcopy(ready[2])
                    proof.update(reusedBinding=True,observationReused=True,independentObservation=False,
                                 localStatistics={'visited':0,'fullTreeQuery':False,'strategy':'consume-immediate-ready-proof'})
                    self.trace('replay.local.consume_ready',{'purpose':op,'match':step['match']},lambda:proof)
                else:
                    tree, proof = self._traced_local_query(recipe, step['match'],
                        0 if op == 'click_if_present' else step.get('min', 1), step.get('max', 1), op,
                        template=step.get('_matchTemplate'))
                result['reusedReads' if proof['reusedBinding'] else 'localQueries'] += 1
                if op == 'assert_rows':
                    result['checks'].append(proof)
                elif op == 'bind_match':
                    retained[step['binding']] = (tree, proof['matches'][0])
                elif not proof['matches']:
                    result['optionalActionSkipped'] = True
                else:
                    if self.lab.actions >= self.lab.max_actions:
                        raise ReplayError('budget-exhausted')
                    row = proof['matches'][0]
                    handle = row['native'] or hwnd
                    l, t, r, b = row['rect']
                    x, y = desktop.api.screen_to_client(handle, (l+r)//2, (t+b)//2)
                    self.lab.actions += 1
                    receipt = self.trace('replay.click', {'match': step['match'], 'double': step.get('double', False),
                        'pointFrom': 'current-bound-target-rectangle'},
                        lambda: desktop.click(handle, x, y, double=step.get('double', False)))
                    if not receipt.get('dispatched'):
                        raise ReplayError('click-effect-unknown')
            elif op == 'ensure_state':
                if step['binding'] not in retained:
                    raise RelearnRequired('learning-required:missing-local-binding')
                try:
                    self._ensure_control_state(step, *retained[step['binding']])
                except UiaError as error:
                    raise RelearnRequired('learning-required:bound-target-stale:' + str(error)) from error
            elif op == 'wait':
                self.trace('replay.wait', step, lambda: time.sleep(step['milliseconds']/1000))
            elif op == 'capture':
                result['preview'] = self._capture()
                if not result['preview']:
                    raise ReplayError('verification-preview-required')
            else:
                raise RelearnRequired('learning-required:unsupported-local-operation')
        return result

    def _bind(self, recipe, force=False):
        if recipe.get('localReplay'):
            if force:
                self._drop()
            return self._bind_local(recipe)
        if force:
            self._drop()
        if self.binding and self.active_recipe != recipe:
            self._drop()  # 显式绑定读取新的 JSON，不能沿用旧配方的引用。
        if self.binding:
            self.trace('replay.environment', {}, lambda: self._environment(recipe)[2])
            for target in recipe['targets']:
                self._target(recipe, target)
            return {'reused': True, 'binding': self.binding, 'fullQueries': 0}
        desktop, hwnd, binding, fp = self._window(recipe)
        try:
            for key, spec in recipe['targets'].items():
                tree = self.tree_factory(desktop, hwnd)
                try:
                    row = self.trace('learn.locate.structured', {'target': key, **spec['selector']},
                                     lambda: self.lab._locate(tree, spec['selector']))
                    learned = recipe.get('learning', {}).get('targets', {}).get(key)
                    if learned:
                        keys = ['role', 'autoId', 'className'] + (['name'] if spec['namePolicy'] == 'exact' else [])
                        if any(row[field] != learned[field] for field in keys):
                            raise ReplayError('learned-target-parameters-changed-learning-required')
                    if spec['namePolicy'] == 'dynamic':
                        pattern = self.trace('learn.pattern.value', {'target': key}, lambda: {'valueReadable': isinstance(tree.value(row['index']), str)})
                        if not pattern['valueReadable']:
                            raise ReplayError('value-pattern-unavailable')
                    self.bound[key] = (tree, row)
                except BaseException:
                    tree.close()
                    raise
            # 查询之间也核对 Session、Instance 和窗口，不能拼接不同实例的学习结果。
            self.binding = binding
            if self._environment(recipe)[3] != fp:
                raise ReplayError('application-changed-during-binding')
            self.active_recipe = copy.deepcopy(recipe)
            return {'reused': False, 'binding': binding, 'fullQueries': len(self.bound), 'fingerprint': fp}
        except BaseException:
            self._drop()
            raise

    def _target(self, recipe, key):
        if key not in self.bound or self.binding is None:
            raise ReplayError('binding-required')
        tree, row = self.bound[key]
        try:
            return self.trace('replay.target.live', {'target': key, 'fullTreeQuery': False},
                              lambda: live_target(tree, row, recipe['targets'][key]))
        except (UiaError, ReplayError) as error:
            if recipe.get('localReplay'):
                raise RelearnRequired('learning-required:bound-target-stale:' + str(error)) from error
            raise

    def _capture(self):
        try:
            info = self.invoke('observe.capture', {'allowUnrendered': False})
            self.publish_preview(info)
            with self.state_lock:
                self.job.pop('previewError', None)
            return info
        except Exception as error:
            with self.state_lock:
                self.job['previewError'] = str(error)
            return None

    def _learn(self, template):
        self._drop()
        recipe = copy.deepcopy(template)
        bound = self._bind(recipe)
        recipe['learning'] = {'learnedAt': time.time(), 'applicationFingerprint': bound['fingerprint'],
                              'validation': 'targets-and-patterns-only',
                              'workflowAcceptance': 'not-revalidated-by-learning', 'targets': {}}
        for key, (_tree, row) in self.bound.items():
            recipe['learning']['targets'][key] = {k: copy.deepcopy(row[k]) for k in
                                                ('role', 'roleName', 'name', 'autoId', 'className')}
        validate_recipe(recipe, True)
        self.learned_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.learned_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(recipe, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(self.learned_path)
        self.active_recipe = recipe
        return {'recipe': recipe, 'binding': self.binding, 'fullQueries': len(self.bound)}

    def _operation(self, recipe, operation, inputs):
        parameters = {}
        for key in operation['inputs']:
            spec = recipe['parameters'][key]
            value = inputs.get(key,spec.get('default') if spec.get('required') is False else None)
            if not isinstance(value, str) or not spec['minLength'] <= len(value.strip()) <= spec['maxLength']:
                raise ReplayError('missing-or-invalid-parameter:' + key)
            parameters[key] = value.strip()
        if operation.get('requiresState'):
            required = operation['requiresState']
            if self.values.get(required['name']) != parameters[required['parameter']]:
                raise ReplayError('verified-input-required')
        original_operation=operation
        operation = substitute(operation, parameters)
        for original,step in zip(original_operation['steps'],operation['steps']):
            if 'match' in original:step['_matchTemplate']=copy.deepcopy(original['match'])
            if 'readyMatch' in original:step['_readyMatchTemplate']=copy.deepcopy(original['readyMatch'])
        if any(s['op'] in ('observe_page', 'observe_local') for s in operation['steps']):
            if recipe.get('localReplay'):
                return self._local_operation(recipe, operation)
            if any(s['op'] == 'observe_local' for s in operation['steps']):
                raise RelearnRequired('learning-required:missing-local-profile')
            return self._page_operation(recipe, operation)
        result = {'fullQueries': 0}
        for step in operation['steps']:
            op = step['op']
            if op in ('launch', 'ensure_app'):
                reuse = op == 'ensure_app' and self.lab.facts().get('ownedAppRunning')
                if not reuse:
                    self._drop()
                probe = self.invoke('env.identity.probe')
                if not probe['hiddenDesktopOpen']:
                    self.invoke('env.hidden.open')
                app = recipe['application']
                if reuse:
                    result['reusedOwnedApplication'] = True
                else:
                    result['launch'] = self.invoke('env.app.launch', {'app': 'custom', 'path': app['executable'], 'args': app['arguments']})
                # 显示定尺前暂不检查目标布局；之后每个局部操作都严格检查物理尺寸。
                window_recipe = copy.deepcopy(recipe)
                window_recipe.pop('localReplay', None)
                self._window(window_recipe, startup=True)
                if recipe.get('localReplay'):
                    self._prepare_local_window(recipe, window_recipe,reuse=reuse)
                else:
                    self.invoke('act.window.fit', recipe['environment']['size'])
            elif op == 'bind':
                result.update(self._bind(recipe))
            elif op == 'capture':
                result['preview'] = self._capture()
                if recipe.get('localReplay') and not result['preview']:
                    raise ReplayError('verification-preview-required')
            elif op == 'wait':
                self.trace('replay.wait', {'milliseconds': step['milliseconds']}, lambda: time.sleep(step['milliseconds'] / 1000))
            else:
                if self.binding is None or self.active_recipe != recipe:
                    raise ReplayError('binding-required')
                self.trace('replay.environment', {}, lambda: self._environment(recipe)[2])
                key = step['target']
                row = self._target(recipe, key)
                tree = self.bound[key][0]
                if op == 'assert_value':
                    actual = self.trace('replay.value.read', {'target': key}, lambda: tree.value(row['index']))
                    if actual != parameters[step['parameter']]:
                        raise ReplayError('value-verification-failed')
                    if step.get('remember'):
                        self.values[step['remember']] = actual
                    result['verifiedValue'] = actual
                else:
                    if self.lab.actions >= self.lab.max_actions:
                        raise ReplayError('budget-exhausted')
                    # 失败也计算动作尝试，避免效果未知时隐式重复不计预算。
                    self.lab.actions += 1
                    if op == 'set_value':
                        self.values.clear()
                        text = parameters[step['parameter']]
                        self.trace('replay.value.set', {'target': key, 'text': text}, lambda: tree.set_value(row['index'], text))
                        result['dispatched'] = True
                    elif op == 'click':
                        if step.get('consume'):
                            self.values.pop(step['consume'], None)
                        hwnd = row['native'] or tree.hwnd
                        left, top, right, bottom = row['rect']
                        x, y = tree.desktop.api.screen_to_client(hwnd, (left + right) // 2, (top + bottom) // 2)
                        receipt = self.trace('replay.click', {'target': key, 'pointFrom': 'current-target-rectangle'},
                                             lambda: tree.desktop.click(hwnd, x, y, double=False))
                        if not receipt.get('dispatched'):
                            raise ReplayError('click-effect-unknown')
                        result['dispatched'] = True
        return result

    def _page_operation(self, recipe, operation):
        """动态页面只在显式观察点重新绑定；同一观察内使用实时身份核验。"""
        observation, tree, original_identity = None, None, None
        retained, trees = {}, []
        result = {'fullQueries': 0, 'checks': []}
        try:
            for step in operation['steps']:
                desktop, hwnd, identity, _fp = self._environment(recipe)
                if original_identity is None:
                    original_identity = identity
                elif identity != original_identity:
                    raise ReplayError('instance-changed-rebind-required')
                self.trace('replay.environment', {}, lambda: identity)
                op = step['op']
                if op == 'observe_page':
                    tree = self.tree_factory(desktop, hwnd)
                    trees.append(tree)
                    def observe():
                        nonlocal observation
                        observation = PageObservation(tree, identity)
                        return {'count': len(observation.rows), 'complete': True, 'scope': 'all-descendants',
                                'window': observation.window, 'items': observation.rows}
                    self.trace('replay.page.observe', {}, observe)
                    result['fullQueries'] += 1
                elif op == 'ensure_state':
                    if step['binding'] not in retained:
                        raise ReplayError('page-binding-required')
                    self._ensure_control_state(step, *retained[step['binding']], local=False)
                    observation=None
                elif op in ('assert_rows', 'click_match', 'click_if_present', 'bind_match'):
                    if observation is None or observation.environment != identity:
                        raise ReplayError('fresh-page-observation-required')
                    proof = self.trace('replay.page.verify', step, lambda: observation.check(
                        step['match'], 0 if op == 'click_if_present' else step.get('min', 1), step.get('max', 1)))
                    if op == 'click_if_present' and not proof['matches']:
                        result['optionalActionSkipped'] = True
                        continue
                    if op == 'bind_match':
                        retained[step['binding']] = (tree, proof['matches'][0])
                    elif op == 'assert_rows':
                        result['checks'].append(proof)
                    else:
                        if self.lab.actions >= self.lab.max_actions:
                            raise ReplayError('budget-exhausted')
                        row = proof['matches'][0]  # 唯一性已验证，绝非从多候选中取首项。
                        handle = row['native'] or hwnd
                        l, t, r, b = row['rect']
                        x, y = desktop.api.screen_to_client(handle, (l+r)//2, (t+b)//2)
                        self.lab.actions += 1
                        receipt = self.trace('replay.click', {'match': step['match'], 'double': step.get('double', False),
                            'pointFrom': 'current-target-rectangle'},
                            lambda: desktop.click(handle, x, y, double=step.get('double', False)))
                        if not receipt.get('dispatched'):
                            raise ReplayError('click-effect-unknown')
                        observation = None  # 有副作用后旧页面快照不能继续当作独立证据。
                elif op == 'wait':
                    self.trace('replay.wait', step, lambda: time.sleep(step['milliseconds']/1000))
                elif op == 'capture':
                    result['preview'] = self._capture()
                    if not result['preview']:
                        raise ReplayError('verification-preview-required')
                else:
                    raise ReplayError('unsupported-page-operation')
            return result
        finally:
            active_error = sys.exc_info()[1]
            release_errors = []
            for observed_tree in trees:
                try:
                    observed_tree.close()
                except Exception as error:
                    release_errors.append(str(error))
            if release_errors:
                detail = 'page-binding-release-failed:' + ';'.join(release_errors)
                with self.state_lock:
                    self.job['cleanupError'] = detail
                if active_error is None:
                    raise ReplayError(detail)

    def _run_capability(self, recipe, inputs):
        if self.library is not None and getattr(self.library, 'require_local', False):
            validate_local_profile(recipe)
        operation = recipe['operations'][0]
        inputs=dict(inputs)
        for key in operation['inputs']:
            if key not in inputs and recipe['parameters'][key].get('required') is False:
                inputs[key]=recipe['parameters'][key].get('default','')
        if set(inputs) != set(operation['inputs']):
            raise ReplayError('capability-input-binding-mismatch')
        # 独立能力可共享同一目标绑定，但必须有完全一致的环境/定位/版本契约。
        if self.binding and self.active_recipe != recipe and self.active_recipe is not None:
            if binding_contract(self.active_recipe) == binding_contract(recipe):
                self.trace('replay.binding.transfer', {'to': recipe['id']}, lambda: {'sameContract': True})
                self.active_recipe = copy.deepcopy(recipe)
            else:
                self._drop()
        return self._operation(recipe, operation, inputs)

    def _run_workflow(self, workflow_id, inputs):
        workflow, parameters, plan = self.library.plan(inputs)
        if workflow['id'] != workflow_id:
            raise ReplayError('unknown-workflow')
        steps = [{'id': s['id'], 'capability': r['id'], 'title': r['title'], 'status': 'pending',
                  'inputs': args} for s, r, args in plan]
        with self.state_lock:
            self.job['workflow'] = {'id': workflow_id, 'parameters': parameters, 'steps': steps}
        original_identity = None
        outputs = []
        try:
            for index, (step, recipe, arguments) in enumerate(plan):
                self.current_step = step['id']
                with self.state_lock:
                    steps[index].update(status='running', startedAt=time.time())
                try:
                    if original_identity is not None and self._environment(recipe)[2] != original_identity:
                        raise ReplayError('workflow-instance-changed')
                    output = self._run_capability(recipe, arguments)
                    identity = self._environment(recipe)[2]
                    if original_identity is not None and identity != original_identity:
                        raise ReplayError('workflow-instance-changed')
                    original_identity = identity
                    outputs.append({'capability': recipe['id'], 'output': output})
                    with self.state_lock:
                        steps[index].update(status='done', finishedAt=time.time(), output=copy.deepcopy(output))
                except Exception as error:
                    with self.state_lock:
                        steps[index].update(status='failed', finishedAt=time.time(), error=str(error))
                    raise
            return {'workflow': workflow_id, 'parameters': parameters, 'steps': outputs,
                    'completion': workflow.get('completion', '整体流程调用完成，请核对结果。'),
                    'acceptance': plan[-1][1]['operations'][0].get('acceptance', 'automatic'),
                    'preview': outputs[-1]['output'].get('preview')}
        finally:
            self.current_step = None

    def _save_verified_operation(self, recipe, operation, result):
        if not result.get('checks') or operation['steps'][-2]['op'] != 'assert_rows' \
                or operation['steps'][-1]['op'] != 'capture':
            raise ReplayError('operation-verification-required')
        recipe['learning'].setdefault('verifiedOperations', {})[operation['id']] = {
            'verifiedAt': time.time(), 'checks': [
                {k: c[k] for k in ('predicate', 'count', 'complete', 'scope')} for c in result['checks']],
            'preview': {k: result['preview'][k] for k in ('sha256', 'capturedAt')},
            'operationSha256': hashlib.sha256(json.dumps(operation, sort_keys=True).encode()).hexdigest(),
            'method': 'real-application-page-assertions-and-capture'}
        validate_recipe(recipe, True)
        temporary = self.learned_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(recipe, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(self.learned_path)
        self._drop()

    def _execute(self, action, inputs):
        acceptance = 'automatic'
        self.paths_contract_checked=False
        self.path_store=None
        self.learning_paths=action.startswith('learn-workflow:')
        try:
            with self.host_lock:
                composition_action = action.startswith(('workflow:', 'learn-workflow:', 'capability:'))
                template = None if composition_action else load_recipe(self.template_path)
                if action == 'reset':
                    self._drop()
                    self.requires_reset = False
                    result, verdict = {'reset': True}, '绑定已清除，学习 JSON 保留。请重新绑定。'
                elif composition_action:
                    if self.library is None:
                        raise ReplayError('skill-library-unavailable')
                    if self.requires_reset:
                        raise ReplayError('reset-or-learning-required')
                    namespace, capability_id = action.split(':', 1)
                    if namespace in ('workflow','learn-workflow'):
                        if self.learning_paths:self._drop()
                        result = self._run_workflow(capability_id, inputs)
                        if self.learning_paths and self.path_store:
                            self.path_store.save()
                            result['learnedPathsFile']=str(self.paths_path)
                        verdict = result['completion']
                        acceptance = result['acceptance']
                    else:
                        recipe = self.library.capability(capability_id)
                        result = self._run_capability(recipe, inputs)
                        acceptance = recipe['operations'][0].get('acceptance', 'automatic')
                        verdict = recipe['operations'][0].get('completion', '子能力调用与核验完成。')
                elif action == 'learn':
                    result = self._learn(template)
                    self.requires_reset = False
                    result['preview'] = self._capture()
                    verdict = '学习 JSON 已保存，当前目标与 ValuePattern 已验证；本次学习不执行输入或搜索。'
                else:
                    learning_operation = action.startswith('learn:')
                    operation_id = action[6:] if learning_operation else action
                    operation = next((o for o in template['operations'] if o['id'] == operation_id), None)
                    if not operation:
                        raise ReplayError('unknown-operation')
                    expected_operation = copy.deepcopy(operation)
                    if self.requires_reset:
                        raise ReplayError('reset-or-learning-required')
                    if learning_operation:
                        if operation.get('learningRequired') is not True:
                            raise ReplayError('operation-not-learnable')
                        saved = load_recipe(self.learned_path, True)
                        recipe = copy.deepcopy(template)
                        recipe['learning'] = copy.deepcopy(saved['learning'])
                        self._drop()
                    elif any(s['op'] == 'launch' for s in operation['steps']):
                        recipe = template
                    else:
                        recipe = load_recipe(self.learned_path, True)
                        operation = next((o for o in recipe['operations'] if o['id'] == action), None)
                        if not operation:
                            raise ReplayError('operation-missing-learning-required')
                        if operation.get('learningRequired') and operation != expected_operation:
                            raise ReplayError('operation-changed-learning-required')
                        if operation.get('learningRequired') and operation_id not in recipe['learning'].get('verifiedOperations', {}):
                            raise ReplayError('operation-learning-required')
                        if operation.get('learningRequired') and recipe['learning']['verifiedOperations'][operation_id].get('operationSha256') != hashlib.sha256(json.dumps(operation, sort_keys=True).encode()).hexdigest():
                            raise ReplayError('operation-changed-learning-required')
                    result = self._operation(recipe, operation, inputs)
                    if learning_operation:
                        self._save_verified_operation(recipe, operation, result)
                        result['saved'] = True
                    acceptance = operation.get('acceptance', 'automatic')
                    verdict = operation.get('completion', '动作与实时核验完成。')
                with self.state_lock:
                    self.finalizing = self.job_path is not None
                    self.job.update(status='done', output=result, finishedAt=time.time(),
                                    verification={'status': '待人工核对' if acceptance == 'manual' else '通过', 'evidence': verdict})
        except Exception as error:
            # _drop 也在此线程，异常或中断后不保留半成品 COM 绑定。
            cleanup_error = None
            try:
                self._drop()
            except Exception as release_error:
                cleanup_error = str(release_error)
            with self.state_lock:
                self.finalizing = self.job_path is not None
                self.requires_reset = True
                code = error.code if isinstance(error, CapabilityError) else str(error)
                evidence = ('需要重新学习：已学目标、局部参数或窗口布局不再匹配。' + code
                            if isinstance(error, RelearnRequired) else code)
                if isinstance(error,TargetQueryError):
                    evidence='已识别局部容器，但未找到唯一匹配目标；请核对歌名、歌手或具体版本。'+code
                self.job.update(status='failed', error=code, finishedAt=time.time(),
                                verification={'status': '失败／未完成', 'evidence': evidence})
                if cleanup_error:
                    self.job['cleanupError'] = cleanup_error
        finally:
            self.learning_paths=False
            if self.job_path:
                try:
                    with self.state_lock:
                        record = copy.deepcopy(self.job)
                    self.job_path.parent.mkdir(parents=True, exist_ok=True)
                    temporary = self.job_path.with_suffix('.tmp')
                    temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
                    temporary.replace(self.job_path)
                except (OSError, ValueError, TypeError) as error:
                    with self.state_lock:
                        self.job['recordError'] = str(error)
                finally:
                    with self.state_lock:
                        self.finalizing = False
