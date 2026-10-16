"""回放 JSON 契约与文件读取：不包含具体应用、歌曲或实测数据。"""
import hashlib
import json
import os
from pathlib import Path

from hidden_desktop_lab.contracts.matching import validate_match


LOCAL_LIMITS = {
    'maxNodes': 256, 'maxDepth': 16,
    'maxCachedQueries': 32, 'maxRetainedElements': 2000,
}


def valid_window_size(size):
    return (isinstance(size, dict) and set(size) == {'width', 'height'}
            and type(size['width']) is int and 400 <= size['width'] <= 2048
            and type(size['height']) is int and 300 <= size['height'] <= 2048)


class RelearnRequired(ValueError):
    pass


class TargetQueryError(ValueError):
    """容器有效，但当前业务参数没有符合声明的候选。"""


class ReplayError(RuntimeError):
    pass


def validate_recipe(recipe, learned=False):
    """有限指令集；不接受代码、表达式或可执行脚本。"""
    def require(ok):
        if not ok:
            raise ReplayError('invalid-learning-json')
    require(isinstance(recipe, dict) and recipe.get('schemaVersion') == 1)
    require(isinstance(recipe.get('id'), str) and 0 < len(recipe['id']) <= 100)
    app, env = recipe.get('application', {}), recipe.get('environment', {})
    require(isinstance(app, dict) and isinstance(env, dict))
    require(isinstance(app.get('executable'), str) and os.path.isabs(app['executable'])
            and app['executable'].lower().endswith('.exe'))
    require(isinstance(app.get('arguments'), str) and len(app['arguments']) <= 1024)
    require(env.get('kind') == 'hidden-desktop')
    window = env.get('window', {})
    require(window.get('kind') == 'className' and isinstance(window.get('value'), str) and bool(window['value']))
    size = env.get('size', {})
    require(valid_window_size(size))
    params, targets, operations = recipe.get('parameters'), recipe.get('targets'), recipe.get('operations')
    require(isinstance(params, dict) and len(params) <= 8)
    for spec in params.values():
        require(isinstance(spec, dict) and spec.get('type') == 'string'
                and type(spec.get('minLength')) is int and type(spec.get('maxLength')) is int
                and (0 if spec.get('required') is False else 1) <= spec['minLength'] <= spec['maxLength'] <= 512)
        require('required' not in spec or type(spec['required']) is bool)
        require('default' not in spec or isinstance(spec['default'],str)
                and spec['minLength']<=len(spec['default'].strip())<=spec['maxLength'])
    require(isinstance(targets, dict) and 1 <= len(targets) <= 8)
    for target in targets.values():
        require(isinstance(target, dict) and target.get('namePolicy') in ('dynamic', 'exact'))
        selector = target.get('selector', {})
        require(selector.get('kind') in ('role', 'autoId', 'label', 'className')
                and isinstance(selector.get('value'), str) and len(selector['value']) <= 512)
        if selector['kind'] == 'role':
            require(isinstance(selector.get('role'), str) and bool(selector['role']))
        require('expectedIdentity' not in selector)
        if target['namePolicy'] == 'dynamic':
            require(selector.get('kind') == 'role' and selector.get('role') == 'Edit')
    require(isinstance(operations, list) and 1 <= len(operations) <= 8)
    ids = set()
    for operation in operations:
        require(isinstance(operation, dict) and isinstance(operation.get('id'), str) and operation['id'] not in ids)
        ids.add(operation['id'])
        require(isinstance(operation.get('title'), str) and isinstance(operation.get('description'), str))
        require(isinstance(operation.get('inputs'), list) and all(p in params for p in operation['inputs']))
        if operation.get('requiresState'):
            required = operation['requiresState']
            require(isinstance(required, dict) and isinstance(required.get('name'), str)
                    and 0 < len(required['name']) <= 64 and required.get('parameter') in operation['inputs'])
        steps = operation.get('steps')
        require(isinstance(steps, list) and 1 <= len(steps) <= 16)
        for step in steps:
            require(isinstance(step, dict) and step.get('op') in
                    ('launch', 'ensure_app', 'bind', 'set_value', 'assert_value', 'click', 'wait', 'capture',
                     'observe_page', 'observe_local', 'assert_rows', 'click_match', 'click_if_present', 'bind_match', 'ensure_state'))
            if step['op'] in ('bind_match', 'ensure_state'):
                require(isinstance(step.get('binding'), str) and 0 < len(step['binding']) <= 64)
            if 'newPageBindings' in step:
                require(step['op']=='observe_local' and step is steps[0] and step['newPageBindings'] is True)
            if 'retainContainerBindings' in step:
                require(step.get('newPageBindings') is True and type(step['retainContainerBindings']) is bool)
            if 'readyMatch' in step:
                require(step['op']=='observe_local' and type(step.get('timeoutMs')) is int and 1<=step['timeoutMs']<=2000)
                try:validate_match(step['readyMatch'])
                except (ValueError,TypeError,RecursionError):require(False)
            if step['op'] == 'ensure_state':
                require(all(isinstance(step.get(k),str) and 0 < len(step[k]) <= 100 for k in ('desiredName','actionName'))
                        and step['desiredName'] != step['actionName'])
            if step['op'] in ('assert_rows', 'click_match', 'click_if_present', 'bind_match'):
                try:
                    validate_match(step.get('match'))
                except (ValueError, TypeError, RecursionError):
                    require(False)
                if step['op'] == 'assert_rows':
                    require(type(step.get('min', 1)) is int and type(step.get('max', 1)) is int
                            and 1 <= step.get('min', 1) <= step.get('max', 1) <= 8)
                else:
                    require('min' not in step and 'max' not in step)
                if 'double' in step:
                    require(type(step['double']) is bool)
            if step['op'] in ('set_value', 'assert_value', 'click'):
                require(step.get('target') in targets)
            if step['op'] in ('set_value', 'assert_value'):
                require(step.get('parameter') in operation['inputs'])
            if step['op'] == 'wait':
                require(type(step.get('milliseconds')) is int and 0 <= step['milliseconds'] <= 2000)
            if 'remember' in step or 'consume' in step:
                state_key = step.get('remember', step.get('consume'))
                require(isinstance(state_key, str) and 0 < len(state_key) <= 64)
    require(recipe.get('replayPolicy') == {
        'binding': 'local-probe-once-per-predicate-and-instance' if recipe.get('localReplay') else 'full-query-once-per-instance',
        'execution': 'bound-target-live-checks',
        'onMissingLearning': 'require-learning', 'onVersionChange': 'require-learning',
        'onStaleTarget': 'require-learning' if recipe.get('localReplay') else 'stop-and-rebind', 'automaticRetry': False})
    if learned:
        learning = recipe.get('learning', {})
        fp = learning.get('applicationFingerprint', {})
        require(learning.get('validation') == 'targets-and-patterns-only'
                and set(learning.get('targets', {})) == set(targets))
        require(isinstance(fp.get('sha256'), str) and len(fp['sha256']) == 64
                and all(c in '0123456789abcdef' for c in fp['sha256']))
        require(isinstance(fp.get('path'), str) and type(fp.get('size')) is int and fp['size'] >= 0)
        for key, observed in learning['targets'].items():
            require(isinstance(observed, dict) and type(observed.get('role')) is int
                    and all(isinstance(observed.get(field), str) for field in ('roleName', 'name', 'autoId', 'className')))
    return recipe


def fingerprint(path):
    path = Path(path)
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return {'path': str(path.resolve()), 'size': path.stat().st_size, 'sha256': digest.hexdigest()}


def load_recipe(path, learned=False):
    try:
        if Path(path).stat().st_size > 65536:
            raise ReplayError('invalid-learning-json')
        return validate_recipe(json.loads(Path(path).read_text(encoding='utf-8')), learned)
    except FileNotFoundError as error:
        raise ReplayError('learning-required') from error
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        raise ReplayError('invalid-learning-json') from error
