"""Run only the reviewed synthetic lab suites; never discover real smoke scripts."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
TESTS = ROOT / 'labs/hidden-desktop/tests'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('suite', choices=('all', 'python', 'js', 'browser'), default='all', nargs='?')
    args = parser.parse_args()
    manifest = json.loads((TESTS / 'offline-suites.json').read_text(encoding='utf-8'))
    env = {key: value for key, value in os.environ.items()
           if not re.match(r'^(COMPUTER_USE_|AGENT_DESKTOP_|JEV_|NETEASE_APP_PATH$)', key)}
    suites = ('python', 'js', 'browser') if args.suite == 'all' else (args.suite,)
    for suite in suites:
        files = manifest[suite]
        # These are source-controlled test basenames, not arbitrary commands/paths.
        suffix = r'test_[a-z0-9_]+\.py' if suite == 'python' else r'[a-z0-9-]+\.test\.(?:cjs|mjs)'
        if not files or len(files) != len(set(files)) or any(
                not re.fullmatch(suffix, name) or not (TESTS / name).is_file() for name in files):
            raise ValueError('invalid-offline-suite')
        if suite == 'python':
            command = [sys.executable, '-m', 'unittest', '-v', *(Path(name).stem for name in files)]
            cwd = TESTS
        else:
            node = shutil.which('node')
            if node is None:
                raise RuntimeError('node-not-found')
            command = [node, '--test', *(str(TESTS / name) for name in files)]
            cwd = ROOT
        print(f'Lab {suite}: {len(files)} explicitly selected synthetic test files', flush=True)
        result = subprocess.run(command, cwd=cwd, env=env)
        if result.returncode:
            return result.returncode
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
