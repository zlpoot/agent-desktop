"""可重新绑定的局部目标路径。长期保存纯 JSON；不保存 COM、PID、HWND 或 RuntimeId。"""
import copy
import hashlib
import json
from pathlib import Path
import re

from replay_contract import RelearnRequired


def query_key(spec):
    return hashlib.sha256(json.dumps(spec,sort_keys=True,ensure_ascii=False).encode()).hexdigest()


def parameterized(value):
    if isinstance(value,str):return bool(re.fullmatch(r'\$\{[a-zA-Z][a-zA-Z0-9_]*\}',value))
    if isinstance(value,dict):return any(parameterized(v) for v in value.values())
    if isinstance(value,list):return any(parameterized(v) for v in value)
    return False


def container_path(paths, layout):
    """由已核验目标及关联目标的共同祖先，提取最深的有名容器；不选择行号。"""
    common=[]
    for hops in zip(*paths):
        if any(hop!=hops[0] for hop in hops[1:]):break
        common.append(copy.deepcopy(hops[0]))
    anchors=[i for i,hop in enumerate(common) if hop['role'] in (50026,50030,50033)
             and not hop.get('nativeAnchor') and hop.get('autoId') not in ('','root')]
    if not anchors:raise RelearnRequired('learning-required:missing-stable-local-container')
    result=common[:anchors[-1]+1]
    # 容器内容高度随搜索结果变化；只保留本次窗口内的几何范围。
    for hop in result:
        l,t,r,b=hop['rect']
        if [l,t,r,b]!=[0,0,0,0]:
            hop['rect']=[max(0,l),max(0,t),min(layout['width'],r),min(layout['height'],b)]
            if hop['rect'][0]>=hop['rect'][2] or hop['rect'][1]>=hop['rect'][3]:
                raise RelearnRequired('learning-required:container-outside-window')
    return result


class LearnedPaths:
    def __init__(self, path, learning=False):
        self.path=Path(path)
        self.data=None
        if not learning and self.path.is_file():
            try:
                if self.path.stat().st_size>262144:raise ValueError('size')
                data=json.loads(self.path.read_text(encoding='utf-8'))
                if data.get('schemaVersion') not in (1,2) or data.get('pathGeometry')!='overlap-and-final-region' or not isinstance(data.get('entries'),dict) \
                        or len(data['entries'])>64:raise ValueError('schema')
                if data['schemaVersion']==2 and (not isinstance(data.get('containers'),dict) or len(data['containers'])>32):
                    raise ValueError('containers')
                self.data=data
            except (ValueError,OSError,AttributeError) as error:
                raise RelearnRequired('learning-required:invalid-path-json') from error

    def begin(self, fingerprint, profile, learning=False):
        contract={'applicationFingerprint':fingerprint,'profile':profile}
        if learning:
            self.data={'schemaVersion':2,'pathGeometry':'overlap-and-final-region',**copy.deepcopy(contract),'entries':{},'containers':{}}
        elif not self.data or any(self.data.get(k)!=v for k,v in contract.items()):
            raise RelearnRequired('learning-required:missing-or-changed-path-contract')

    def get(self, spec):
        entry=self.data['entries'].get(query_key(spec)) if self.data else None
        if not isinstance(entry,dict) or entry.get('match')!=spec:
            raise RelearnRequired('learning-required:missing-target-path')
        if entry.get('mode')=='container':
            ref=entry.get('containerRef')
            if not isinstance(ref,str) or not re.fullmatch('[0-9a-f]{64}',ref):
                raise RelearnRequired('learning-required:invalid-container-reference')
            container=self.data.get('containers',{}).get(ref)
            if not isinstance(container,dict) or not container.get('path'):
                raise RelearnRequired('learning-required:missing-local-container')
            return {'mode':'container','containerRef':entry['containerRef'],'containerPath':copy.deepcopy(container['path'])}
        if not entry.get('paths'):raise RelearnRequired('learning-required:missing-target-path')
        return copy.deepcopy(entry['paths'])

    def record(self, spec, paths):
        if not paths:return  # 不把一次缺席保存成永久不执行。
        if 'bindingScope' in spec and spec['bindingScope'] != 'container':
            raise RelearnRequired('learning-required:invalid-binding-scope')
        key=query_key(spec)
        if key not in self.data['entries'] and len(self.data['entries'])>=64:
            raise RelearnRequired('learning-required:path-budget')
        if parameterized(spec) or spec.get('bindingScope') == 'container':
            path=container_path(paths,self.data['profile']['layout'])
            ref=query_key(path)
            containers=self.data.setdefault('containers',{})
            if ref not in containers and len(containers)>=32:raise RelearnRequired('learning-required:container-budget')
            containers[ref]={'path':path,'autoId':path[-1]['autoId']}
            self.data['entries'][key]={'match':copy.deepcopy(spec),'mode':'container','containerRef':ref}
        else:
            self.data['entries'][key]={'match':copy.deepcopy(spec),'paths':paths}

    def save(self):
        encoded=json.dumps(self.data,ensure_ascii=False,indent=2)
        if len(encoded.encode())>262144:raise RelearnRequired('learning-required:path-budget')
        self.path.parent.mkdir(parents=True,exist_ok=True)
        temporary=self.path.with_suffix('.tmp')
        temporary.write_text(encoded,encoding='utf-8');temporary.replace(self.path)
