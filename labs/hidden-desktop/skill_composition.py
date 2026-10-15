"""labs 的能力目录及流程引用；只读 JSON，不执行表达式或加载任意代码。"""
import copy
import hashlib
import json
from pathlib import Path
import re


class CompositionError(ValueError):
    pass


def read_json(path):
    path = Path(path)
    if path.stat().st_size > 65536:
        raise CompositionError('composition-json-too-large')
    return json.loads(path.read_text(encoding='utf-8'))


def digest(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def identifier(value):
    return isinstance(value, str) and bool(re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_.-]{0,99}', value)) and '..' not in value


def validate_workflow(data):
    if not isinstance(data, dict) or data.get('schemaVersion') != 1 or data.get('kind') != 'workflow' \
            or not identifier(data.get('id')) or not isinstance(data.get('title'), str) \
            or data.get('automaticRetry') is not False or data.get('onFailure') != 'stop':
        raise CompositionError('invalid-lab-workflow')
    parameters = data.get('parameters')
    if not isinstance(parameters, dict) or not 1 <= len(parameters) <= 8:
        raise CompositionError('invalid-workflow-parameters')
    for key, spec in parameters.items():
        if not identifier(key) or not isinstance(spec, dict) or spec.get('type') != 'string' or type(spec.get('maxLength')) is not int \
                or not 1 <= spec['maxLength'] <= 512:
            raise CompositionError('invalid-workflow-parameter')
        if 'required' in spec and type(spec['required']) is not bool:
            raise CompositionError('invalid-workflow-parameter')
        if 'default' in spec and (not isinstance(spec['default'],str)
                or not (0 if spec.get('required') is False else 1)<=len(spec['default'].strip())<=spec['maxLength']):
            raise CompositionError('invalid-workflow-parameter-default')
    steps = data.get('steps')
    if not isinstance(steps, list) or not 1 <= len(steps) <= 8:
        raise CompositionError('invalid-workflow-steps')
    seen = set()
    for step in steps:
        if not isinstance(step, dict) or not identifier(step.get('id')) or step['id'] in seen or not identifier(step.get('capability')) \
                or type(step.get('revision')) is not int or not isinstance(step.get('inputs'), dict) \
                or not re.fullmatch('[0-9a-f]{64}', str(step.get('definitionSha256', ''))):
            raise CompositionError('invalid-workflow-reference')
        seen.add(step['id'])
        for value in step['inputs'].values():
            resolve_value(value, {p: 'synthetic' for p in parameters})
    return data


def workflow_inputs(workflow, inputs):
    if not isinstance(inputs, dict) or set(inputs) - set(workflow['parameters']):
        raise CompositionError('invalid-workflow-inputs')
    result = {}
    for key, spec in workflow['parameters'].items():
        value = inputs.get(key, spec.get('default'))
        minimum=0 if spec.get('required') is False else 1
        if not isinstance(value, str) or not minimum <= len(value.strip()) <= spec['maxLength']:
            raise CompositionError('missing-or-invalid-parameter:' + key)
        result[key] = value.strip()
    return result


def resolve_value(value, parameters):
    if isinstance(value, str):
        return value
    if not isinstance(value, dict):
        raise CompositionError('invalid-input-binding')
    if set(value) == {'input'} and isinstance(value['input'], str) and value['input'] in parameters:
        return parameters[value['input']]
    if set(value) == {'join', 'separator'} and isinstance(value['join'], list) and 1 <= len(value['join']) <= 8 \
            and all(isinstance(v, dict) and set(v) == {'input'} for v in value['join']) \
            and isinstance(value['separator'], str) and len(value['separator']) <= 4:
        result = value['separator'].join(resolve_value(v, parameters) for v in value['join'])
        if len(result) <= 512:
            return result
    raise CompositionError('invalid-input-binding')


def substitute(value, parameters):
    """只替换整个 JSON 字符串中的 ${parameter}，不支持代码或内嵌表达式。"""
    if isinstance(value, str) and value.startswith('${') and value.endswith('}'):
        key = value[2:-1]
        if key not in parameters:
            raise CompositionError('missing-operation-parameter:' + key)
        return parameters[key]
    if isinstance(value, list):
        return [substitute(v, parameters) for v in value]
    if isinstance(value, dict):
        return {key: substitute(v, parameters) for key, v in value.items()}
    return copy.deepcopy(value)


class SkillLibrary:
    def __init__(self, workflow_path, capabilities_dir, validator, require_local=False):
        self.workflow_path, self.capabilities_dir = Path(workflow_path), Path(capabilities_dir)
        self.validator = validator
        self.require_local = require_local

    def capability(self, capability_id):
        if not identifier(capability_id):
            raise CompositionError('invalid-capability-id')
        path = (self.capabilities_dir / (capability_id + '.json')).resolve()
        if path.parent != self.capabilities_dir.resolve():
            raise CompositionError('capability-path-outside-library')
        try:
            recipe = self.validator(read_json(path), True)
        except (OSError, ValueError, RuntimeError, TypeError, KeyError, AttributeError) as error:
            if self.require_local:
                from replay_contract import RelearnRequired
                raise RelearnRequired('learning-required:invalid-or-missing-capability:' + capability_id) from error
            if not isinstance(error, (TypeError, KeyError, AttributeError)):
                raise
            raise CompositionError('invalid-standalone-capability') from error
        if recipe.get('kind') != 'learned-capability' or recipe['id'] != capability_id \
                or len(recipe['operations']) != 1 or recipe['operations'][0]['id'] != capability_id:
            raise CompositionError('invalid-standalone-capability')
        if self.require_local:
            from local_replay import validate_local_profile
            validate_local_profile(recipe)
        return recipe

    def plan(self, inputs):
        workflow = validate_workflow(read_json(self.workflow_path))
        parameters = workflow_inputs(workflow, inputs)
        result = []
        for step in workflow['steps']:
            recipe = self.capability(step['capability'])
            if recipe.get('revision') != step['revision'] or digest(recipe) != step['definitionSha256']:
                raise CompositionError('capability-definition-changed:' + recipe['id'])
            operation = recipe['operations'][0]
            arguments = {k: resolve_value(v, parameters) for k, v in step['inputs'].items()}
            if set(arguments) != set(operation['inputs']):
                raise CompositionError('capability-input-binding-mismatch')
            for key, value in arguments.items():
                spec = recipe['parameters'][key]
                if not spec['minLength'] <= len(value) <= spec['maxLength']:
                    raise CompositionError('invalid-capability-input:' + key)
            result.append((step, recipe, arguments))
        return workflow, parameters, result

    def summary(self):
        workflow = validate_workflow(read_json(self.workflow_path))
        _w, _p, plan = self.plan({})
        return {'workflow': workflow, 'capabilities': [recipe for _s, recipe, _a in plan],
                'workflowFile': str(self.workflow_path), 'capabilitiesDirectory': str(self.capabilities_dir)}


def binding_contract(recipe):
    return {key: recipe[key] for key in ('application', 'environment', 'targets')} | {
        'learning': {key: recipe['learning'][key] for key in ('applicationFingerprint', 'targets')},
        'localReplay': recipe.get('localReplay')}
