"""固定布局的已学局部定位与实例内绑定。无 FindAll，无全树回退。"""
import copy
import json

from replay_observation import PageObservation, validate_match, matches, relations
from replay_contract import LOCAL_LIMITS, RelearnRequired, TargetQueryError, valid_window_size


def validate_local_profile(recipe):
    profile = recipe.get('localReplay')
    if not isinstance(profile, dict) or profile.get('version') != 1 \
            or profile.get('mode') != 'bound-targets-local-probes' \
            or profile.get('coordinateSpace') != 'physical-window' \
            or profile.get('scopePolicy') != 'control-view-visible-ancestor-containment' \
            or any(profile.get(key) != value for key, value in LOCAL_LIMITS.items()) \
            or not valid_window_size(profile.get('layout')) \
            or recipe.get('environment', {}).get('size') != profile['layout']:
        raise RelearnRequired('learning-required:missing-or-invalid-local-profile')
    for target in recipe['targets'].values():
        region = target.get('probeRegion')
        try:
            validate_match({'role': 50004, 'anyName': True, 'region': region})
        except (TypeError, ValueError):
            raise RelearnRequired('learning-required:missing-target-local-region')
        if region is None:
            raise RelearnRequired('learning-required:missing-target-local-region')
    for operation in recipe['operations']:
        for step in operation['steps']:
            if step['op'] in ('assert_rows', 'click_match', 'click_if_present', 'bind_match'):
                if not isinstance(step.get('match'), dict) or step['match'].get('region') is None:
                    raise RelearnRequired('learning-required:missing-operation-local-region')
    return profile


class LocalObservation(PageObservation):
    def __init__(self, tree, environment, region, profile, paths=None):
        self.tree = tree
        self.container_binding=isinstance(paths,dict) and paths.get('mode')=='container'
        if self.container_binding:
            self.rows=tree.container_rows(paths['containerPath'],region,profile['maxNodes'],profile['maxDepth'])
        else:
            self.rows = (tree.rebind_paths(paths,profile['maxNodes'],profile['maxDepth']) if paths is not None
                         else tree.local_rows(region, profile['maxNodes'], profile['maxDepth']))
        self.window = tree.desktop.api.window_rect(tree.hwnd)
        self.environment = environment
        self.region = region
        self.path_binding=paths is not None and not self.container_binding

    def check(self, spec, minimum=1, maximum=1):
        try:proof = super().check(spec, minimum, maximum,select_first=spec.get('selectionPolicy')=='first-visible-match')
        except ValueError as error:
            if getattr(self,'container_binding',False) and str(error).startswith('page-match-count:'):
                failure=TargetQueryError(str(error))
                failure.observation={'unverifiedCandidates':matches(self.rows,spec,self.window),
                    'visibleContext':[{'role':row['role'],'name':row['name'],'rect':row['rect']} for row in self.rows
                                      if row['name'] and not row['offscreen']][:100]}
                raise failure from error
            raise
        proof.update(scope='learned-local-region', region=self.region, globalUnique=None,
                     completeness='declared-region-and-ancestor-containment', fullTreeQuery=False)
        proof['localStatistics'] = copy.deepcopy(getattr(self.tree, 'local_stats', {}))
        if getattr(self,'path_binding',False):
            proof.update(scope='learned-target-identity-path',completeness='declared-path-candidates-only')
        if getattr(self,'container_binding',False):
            proof.update(scope='learned-container-visible-region',completeness='declared-container-and-region')
        return proof


class LocalBindings:
    def __init__(self, profile, identity):
        self.profile, self.identity = copy.deepcopy(profile), copy.deepcopy(identity)
        self.entries = {}
        self.containers = {}

    def trees(self):
        return list({id(tree):tree for tree in [entry['observation'].tree for entry in self.entries.values()]
                     +list(self.containers.values())}.values())

    def reset_page(self):
        keep={id(tree) for tree in self.containers.values()}
        closed=set()
        for tree in self.trees():
            if id(tree) in keep:tree.retain_local_container()
            else:tree.close();closed.add(id(tree))
        self.entries.clear()
        return closed

    def query(self, spec, minimum, maximum, factory, identity, paths=None, capture_paths=False):
        region = spec.get('queryRegion',spec.get('region'))
        if region is None:
            raise RelearnRequired('learning-required:missing-local-region')
        if identity != self.identity:
            raise RelearnRequired('learning-required:instance-changed')
        key = json.dumps([spec, minimum, maximum], sort_keys=True)
        if key in self.entries:
            entry = self.entries[key]
            # 引用只用于寻址；现场重读名称、角色、祖先、矩形，再核对局部谓词。
            tree = entry['observation'].tree
            rows = copy.deepcopy(entry['rows'])
            for row in rows:
                if row.get('_dynamicName'):
                    row['name'] = tree._string(tree.elements[row['index']], 23)
            observation = object.__new__(LocalObservation)
            observation.tree, observation.rows = tree, rows
            observation.environment, observation.region = identity, region
            observation.path_binding=getattr(entry['observation'],'path_binding',False)
            observation.container_binding=getattr(entry['observation'],'container_binding',False)
            observation.window = tree.desktop.api.window_rect(tree.hwnd)
            proof = observation.check(spec, minimum, maximum)
            for row in proof['matches']:
                row['native']=tree._integer(tree.elements[row['index']],36)
            if spec.get('selectionPolicy')=='first-visible-match':
                proof['candidateCountAtBinding']=entry['candidateCountAtBinding']
                proof['candidateCount']=None  # 暖读核验已绑定目标，未重新枚举全部候选。
            proof['reusedBinding'] = True
            proof['localStatistics'] = {'visited': 0, 'fullTreeQuery': False}
            return tree, proof
        if len(self.entries) >= self.profile['maxCachedQueries']:
            raise RelearnRequired('learning-required:local-binding-budget')
        container_ref=paths.get('containerRef') if isinstance(paths,dict) and paths.get('mode')=='container' else None
        tree = self.containers.get(container_ref) if container_ref else None
        if tree is None:tree=factory()
        try:
            tree.local_projection_roles={spec['role']}|{near['role'] for near in relations(spec)}
            observation = LocalObservation(tree, identity, region, self.profile, paths)
            retained = sum(len(t.elements) for t in {id(t):t for t in self.trees()+[tree]}.values())
            if retained > self.profile['maxRetainedElements']:
                raise RelearnRequired('learning-required:local-binding-budget')
            proof = observation.check(spec, minimum, maximum)
            proof['reusedBinding'] = False
            if not proof['matches']:
                tree.close()  # 不缓存“缺席”，页面变化后须重新作局部只读核验。
                return None, proof
            # 仅保留真正用于身份和关系核验的行；无关动态歌词不参加暖绑定检查。
            rows = copy.deepcopy(proof['matches'])
            for row in rows:
                row['_dynamicName'] = 'name' not in spec
            existing={row['index'] for row in rows}
            rows.extend(copy.deepcopy(peer) for peer in proof['relatedMatches'] if peer['index'] not in existing)
            self.entries[key] = {'observation': observation, 'rows': rows,'candidateCountAtBinding':proof.get('candidateCount')}
            if container_ref and hasattr(tree,'retain_local_container'):
                self.containers[container_ref]=tree
            if capture_paths:
                proof['learnedPaths']=[tree.export_path(row) for row in rows]
            return tree, proof
        except BaseException:
            self.entries={k:v for k,v in self.entries.items() if v['observation'].tree is not tree}
            self.containers={k:v for k,v in self.containers.items() if v is not tree}
            tree.close()
            raise
