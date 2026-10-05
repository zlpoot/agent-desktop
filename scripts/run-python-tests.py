"""Run every Worker/collector contract file; never initialize physical input."""
from pathlib import Path
import subprocess
import sys
failed = []
for path in sorted(Path('tests').glob('*.py')):
    # Worker modules keep process-wide control singletons. Isolate files, as live
    # Worker instances are isolated, instead of sharing state between suites.
    result = subprocess.run([sys.executable, str(path), '-v'])
    if result.returncode:
        failed.append(str(path))
print(f'Python contract files: {len(list(Path("tests").glob("*.py")))}; failed: {failed}')
sys.exit(bool(failed))
