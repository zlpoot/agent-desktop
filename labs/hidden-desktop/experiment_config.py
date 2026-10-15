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


def load_experiment(root):
    root = Path(root).resolve()
    manifest = root / 'experiment.json'
    try:
        if manifest.stat().st_size > 16384:
            raise ValueError('experiment-config-too-large')
        data = json.loads(manifest.read_text(encoding='utf-8'))
        fields = ('template', 'learned', 'workflow', 'capabilities', 'paths', 'record')
        if not isinstance(data, dict) or data.get('schemaVersion') != 1 \
                or set(data) != {'schemaVersion', 'page', *fields}:
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
        return ExperimentConfig(**{key: local_path(data[key]) for key in fields},
                                page_route=page['route'], page_file=local_path(page['file']))
    except (OSError, TypeError, KeyError) as error:
        raise ValueError('invalid-or-missing-experiment-config') from error
