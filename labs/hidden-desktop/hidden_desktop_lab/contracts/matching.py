"""Pure page-match validation shared by native queries and replay."""


def validate_match(spec):
    if not isinstance(spec, dict) or type(spec.get('role')) is not int \
            or not (isinstance(spec.get('name'), str) or isinstance(spec.get('autoId'), str) and bool(spec['autoId'])
                    or spec.get('anyName') is True):
        raise ValueError('invalid-page-match')
    if 'selectionPolicy' in spec and spec['selectionPolicy']!='first-visible-match':
        raise ValueError('invalid-selection-policy')
    if 'bindingScope' in spec and spec['bindingScope'] != 'container':
        raise ValueError('invalid-page-binding-scope')
    if 'nameAliases' in spec:
        aliases = spec['nameAliases']
        if not isinstance(spec.get('name'), str) or not isinstance(aliases, dict) or not 1 <= len(aliases) <= 8:
            raise ValueError('invalid-page-name-aliases')
        for name, values in aliases.items():
            if not isinstance(name, str) or not 1 <= len(name) <= 512 \
                    or not isinstance(values, list) or not 1 <= len(values) <= 8 \
                    or any(not isinstance(value, str) or not 1 <= len(value) <= 512 for value in values) \
                    or len(set(values)) != len(values):
                raise ValueError('invalid-page-name-aliases')
    for region in (spec.get('region'),spec.get('queryRegion')):
        if region is not None and not (isinstance(region, list) and len(region) == 4
            and all(type(n) in (int, float) and 0 <= n <= 1 for n in region)
            and region[0] < region[2] and region[1] < region[3]):
            raise ValueError('invalid-page-region')
    if 'nearAll' in spec and (not isinstance(spec['nearAll'],list) or not 1<=len(spec['nearAll'])<=4):
        raise ValueError('invalid-page-relations')
    for near in ([spec['near']] if 'near' in spec else [])+spec.get('nearAll',[]):
        validate_match(near)
        if 'near' in near or 'nearAll' in near or not all(isinstance(near.get(k), list) and len(near[k]) == 2
                and all(type(n) in (int, float) and -1024 <= n <= 1024 for n in near[k])
                and near[k][0] <= near[k][1] for k in ('dx', 'dy')):
            raise ValueError('invalid-page-relation')
        if 'optionalIfEmpty' in near and type(near['optionalIfEmpty']) is not bool:
            raise ValueError('invalid-optional-page-relation')
        if not (type(near.get('min',1)) is int and type(near.get('max',1)) is int
                and 1<=near.get('min',1)<=near.get('max',1)<=8):
            raise ValueError('invalid-page-relation-count')
