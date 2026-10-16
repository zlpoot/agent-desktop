"""实验入口配置；共用服务不内置应用名、任务参数或学习文件名。"""
from dataclasses import dataclass
import json
from pathlib import Path
import re


@dataclass(frozen=True)
class ExperimentConfig:
    template: Path
    learned: Path
    workflow: Path
    capabilities: Path
    paths: Path
    record: Path
    page_route: str
    page_file: Path
    manual_flow: Path | None = None
    additional_workflows: tuple = ()


def load_experiment(root):
    root = Path(root).resolve()
    manifest = root / 'experiment.json'
    try:
        if manifest.stat().st_size > 16384:
            raise ValueError('experiment-config-too-large')
        data = json.loads(manifest.read_text(encoding='utf-8'))
        fields = ('template', 'learned', 'workflow', 'capabilities', 'paths', 'record')
        if not isinstance(data, dict) or data.get('schemaVersion') != 1 \
                or set(data) - {'schemaVersion', 'page', 'manualFlow', 'additionalWorkflows', *fields} \
                or not {'schemaVersion', 'page', *fields} <= set(data):
            raise ValueError('invalid-experiment-config')

        def local_path(value):
            if not isinstance(value, str) or not value or Path(value).is_absolute() \
                    or '..' in Path(value).parts:
                raise ValueError('invalid-experiment-path')
            result = (root / value).resolve()
            if result == root or not result.is_relative_to(root):
                raise ValueError('experiment-path-outside-lab')
            return result

        page = data['page']
        if not isinstance(page, dict) or set(page) != {'route', 'file'} \
                or not isinstance(page['route'], str) \
                or not re.fullmatch(r'/workflows/[a-zA-Z0-9_-]+', page['route']):
            raise ValueError('invalid-experiment-page')
        extra = data.get('additionalWorkflows', [])
        if not isinstance(extra, list) or len(extra) > 8:
            raise ValueError('invalid-additional-workflows')
        configured, keys, routes = [], {'default'}, {page['route']}
        for item in extra:
            if not isinstance(item, dict) or set(item) != {'key', 'route', 'aliases', 'workflow', 'capabilities', 'profiles', 'record'} \
                    or not isinstance(item['key'], str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,31}', item['key']) \
                    or item['key'] in keys or not isinstance(item['aliases'], list) or len(item['aliases']) > 4:
                raise ValueError('invalid-additional-workflow')
            paths = [item['route'], *item['aliases']]
            for route in paths:
                if not isinstance(route, str) or not re.fullmatch(r'/(?:workflows/)?[a-zA-Z0-9_-]+', route) or route in routes:
                    raise ValueError('duplicate-or-invalid-workflow-route')
                routes.add(route)
            keys.add(item['key'])
            configured.append({**item, **{k: local_path(item[k]) for k in ('workflow', 'capabilities', 'profiles', 'record')}})
        return ExperimentConfig(**{key: local_path(data[key]) for key in fields},
                                page_route=page['route'], page_file=local_path(page['file']),
                                manual_flow=local_path(data['manualFlow']) if 'manualFlow' in data else None,
                                additional_workflows=tuple(configured))
    except (OSError, TypeError, KeyError) as error:
        raise ValueError('invalid-or-missing-experiment-config') from error
