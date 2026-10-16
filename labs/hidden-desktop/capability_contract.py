"""面向调用方的精简 JSON 契约；兼容执行定义由内容哈希引用，不复制或改写。"""
import copy

from skill_composition import SkillLibrary, CompositionError, digest, identifier, read_json


class ContractLibrary(SkillLibrary):
    def __init__(self, *args, contracts_path, **kwargs):
        super().__init__(*args, **kwargs)
        self.contracts_path = contracts_path

    def contract(self, recipe):
        data = read_json(self.contracts_path)
        if not isinstance(data, dict) or set(data) != {'schemaVersion', 'capabilities'} or data['schemaVersion'] != 1 \
                or not isinstance(data['capabilities'], list) or not 1 <= len(data['capabilities']) <= 16:
            raise CompositionError('invalid-capability-contracts')
        ids = [c.get('id') for c in data['capabilities'] if isinstance(c, dict)]
        if len(ids) != len(data['capabilities']) or not all(identifier(i) for i in ids) or len(set(ids)) != len(ids):
            raise CompositionError('invalid-capability-contract-ids')
        contracts = [c for c in data['capabilities'] if c['id'] == recipe['id']]
        if len(contracts) != 1:
            raise CompositionError('capability-contract-missing:' + recipe['id'])
        contract = copy.deepcopy(contracts[0])
        if set(contract) != {'id', 'title', 'description', 'parameters', 'targets', 'preconditions', 'verification', 'implementationSha256'} \
                or any(not isinstance(contract[k], str) or not 1 <= len(contract[k]) <= 512 for k in ('title', 'description')) \
                or contract['implementationSha256'] != digest(recipe):
            raise CompositionError('capability-contract-source-changed:' + recipe['id'])
        operation = recipe['operations'][0]
        for key, available in [('parameters', recipe['parameters']), ('targets', recipe['targets'])]:
            keys = contract[key]
            if not isinstance(keys, list) or any(not isinstance(k, str) or k not in available for k in keys) or len(set(keys)) != len(keys):
                raise CompositionError('invalid-capability-contract-fields')
        if set(contract['parameters']) != set(operation['inputs']):
            raise CompositionError('capability-contract-input-mismatch')
        if not isinstance(contract['verification'], list) or not 1 <= len(contract['verification']) <= 8 \
                or any(not isinstance(s, str) or not 1 <= len(s) <= 512 for s in contract['verification']):
            raise CompositionError('invalid-capability-contract-verification')
        requirements = contract['preconditions']
        if not isinstance(requirements, dict) or set(requirements) - {'ownedApplication', 'boundTargets', 'verifiedInput'} \
                or not {'ownedApplication', 'boundTargets'} <= set(requirements) \
                or type(requirements['ownedApplication']) is not bool or not isinstance(requirements['boundTargets'], list) \
                or any(not isinstance(k, str) or k not in contract['targets'] for k in requirements['boundTargets']) \
                or len(set(requirements['boundTargets'])) != len(requirements['boundTargets']):
            raise CompositionError('invalid-capability-preconditions')
        if 'verifiedInput' in requirements:
            value = requirements['verifiedInput']
            if not isinstance(value, dict) or set(value) != {'state', 'parameter'} \
                    or not identifier(value['state']) or not isinstance(value['parameter'], str) or value['parameter'] not in contract['parameters'] \
                    or operation.get('requiresState') != {'name': value['state'], 'parameter': value['parameter']}:
                raise CompositionError('invalid-capability-verified-input')
        required = operation.get('requiresState')
        if required and 'verifiedInput' not in requirements:
            raise CompositionError('capability-contract-omits-required-state')
        contract['parameters'] = {k: copy.deepcopy(recipe['parameters'][k]) for k in contract['parameters']}
        contract['targets'] = {k: copy.deepcopy(recipe['targets'][k]) for k in contract['targets']}
        contract['localTargets'] = []
        for step in operation['steps']:
            for field in ('readyMatch', 'match'):
                if field in step and step[field] not in contract['localTargets']:
                    contract['localTargets'].append(copy.deepcopy(step[field]))
        contract['implementation'] = {'capability': recipe['id'], 'revision': recipe['revision'],
                                      'definitionSha256': contract.pop('implementationSha256')}
        contract['recordedVerification'] = copy.deepcopy(recipe.get('verification'))
        return contract

    def capability(self, capability_id):
        recipe = super().capability(capability_id)
        self.contract(recipe)
        return recipe

    def summary(self):
        result = super().summary()
        result['contracts'] = [self.contract(recipe) for recipe in result['capabilities']]
        return result

    def check_preconditions(self, replay, recipe, inputs):
        contract = self.contract(recipe)
        parameters = {}
        for key, spec in contract['parameters'].items():
            value = inputs.get(key)
            if not isinstance(value, str) or not spec['minLength'] <= len(value.strip()) <= spec['maxLength']:
                raise CompositionError('missing-or-invalid-parameter:' + key)
            parameters[key] = value.strip()
        requirements = contract['preconditions']
        if requirements['ownedApplication']:
            if not replay.lab.facts().get('ownedAppRunning'):
                raise CompositionError('application-not-started')
            replay._environment(recipe)  # 本轮实例、镜像、版本、归属与窗口规格；不用调用方申报。
        keys = requirements['boundTargets']
        if keys and (replay.binding is None or any(k not in replay.bound for k in keys)):
            raise CompositionError('binding-required')
        verified = requirements.get('verifiedInput')
        if verified and replay.values.get(verified['state']) != parameters[verified['parameter']]:
            raise CompositionError('verified-input-required')
        return {'capability': recipe['id'], 'requirements': requirements, 'passed': True}
