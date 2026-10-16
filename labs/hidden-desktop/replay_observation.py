"""共用回放的页面观察：完整候选集 + 声明式身份/区域约束，不按数组位置选目标。"""
import copy
from hidden_desktop_lab.contracts.uia import ROLE_NAMES
from hidden_desktop_lab.contracts.matching import validate_match


def relations(spec):
    return [near for near in ([spec['near']] if 'near' in spec else [])+spec.get('nearAll',[])
            if not (near.get('optionalIfEmpty') is True and near.get('name')=='')]


def name_matches(actual, spec):
    """仅接受声明中的准确名称/直接别名；不截断、模糊匹配或猜测显示名前缀。"""
    if 'name' not in spec:
        return True
    expected = spec['name']
    return actual == expected or actual in spec.get('nameAliases', {}).get(expected, [])


def matches(rows, spec, window):
    """区域是固定界面配置的一部分；对所有候选评估同一谓词，不截取第 N 项。"""
    left, top, right, bottom = window
    width, height = right - left, bottom - top
    def base(row):
        if row['role'] != spec['role'] or not name_matches(row['name'], spec) \
                or ('autoId' in spec and row.get('autoId') != spec['autoId']):
            return False
        x1, y1, x2, y2 = row['rect']
        if not row['enabled'] or row['offscreen'] or not (left <= x1 < x2 <= right and top <= y1 < y2 <= bottom):
            return False
        region = spec.get('region')
        if region and not (region[0] <= (x1-left)/width and (x2-left)/width <= region[2]
                           and region[1] <= (y1-top)/height and (y2-top)/height <= region[3]):
            return False
        for near in relations(spec):
            related = matches(rows, near, window)
            related = [r for r in related if near['dx'][0] <= r['rect'][0]-x1 <= near['dx'][1]
                       and near['dy'][0] <= r['rect'][1]-y1 <= near['dy'][1]]
            if not near.get('min',1)<=len(related)<=near.get('max',1):
                return False
        return True
    return [copy.deepcopy(row) for row in rows if base(row)]


class PageObservation:
    def __init__(self, tree, recipe_environment):
        self.tree = tree
        # 动态歌词等非目标节点可能不提供 RuntimeId。仍读取全部候选，
        # 只把身份读取推迟到匹配完成；任何目标身份缺失继续明确失败。
        self.rows = tree.enumerate(set(ROLE_NAMES), settle=False, identities=False)
        if tree.truncated:
            raise ValueError('page-query-incomplete')
        self.window = tree.desktop.api.window_rect(tree.hwnd)
        self.environment = recipe_environment

    def check(self, spec, minimum=1, maximum=1, select_first=False):
        selected = matches(self.rows, spec, self.window)
        candidate_count=len(selected)
        if select_first:selected=sorted(selected,key=lambda row:(row['rect'][1],row['rect'][0]))[:1]
        if not minimum <= len(selected) <= maximum:
            raise ValueError('page-match-count:%d:expected-%d..%d' % (len(selected), minimum, maximum))
        verified,related={},{}
        def prove(row):
            if row['index'] in verified:
                row.update(copy.deepcopy(verified[row['index']]))
                return
            if row.get('runtimeId') is None:
                row['runtimeId'] = self.tree.runtime_id(self.tree.elements[row['index']])
            self.tree.prove_target(row)
            verified[row['index']]=copy.deepcopy(row)
        for row in selected:
            prove(row)
            for near in relations(spec):
                for peer in matches(self.rows, near, self.window):
                    if near['dx'][0] <= peer['rect'][0]-row['rect'][0] <= near['dx'][1] \
                            and near['dy'][0] <= peer['rect'][1]-row['rect'][1] <= near['dy'][1]:
                        prove(peer)
                        related[peer['index']]=peer
                        if not (near['dx'][0] <= peer['rect'][0]-row['rect'][0] <= near['dx'][1]
                                and near['dy'][0] <= peer['rect'][1]-row['rect'][1] <= near['dy'][1]):
                            raise ValueError('page-relation-changed')
        # prove_target 会重读矩形；重新评估谓词，拒绝观察与操作之间移动的目标。
        current = {r['index']: r for r in selected}
        refreshed = [verified.get(r['index'], r) for r in self.rows]
        fresh=matches(refreshed,spec,self.window)
        if select_first:fresh=sorted(fresh,key=lambda row:(row['rect'][1],row['rect'][0]))[:1]
        if {r['index'] for r in fresh} != set(current):
            raise ValueError('page-match-changed')
        if self.tree.desktop.api.window_rect(self.tree.hwnd) != self.window:
            raise ValueError('page-window-geometry-changed')
        return {'matches': selected, 'complete': True, 'scope': 'all-descendants',
                'relatedMatches':list(related.values()),'identityProofCount':len(verified),
                **({'selectionPolicy':'first-visible-match','candidateCount':candidate_count,'unique':False} if select_first else {}),
                'predicate': spec, 'window': self.window, 'count': len(selected)}
