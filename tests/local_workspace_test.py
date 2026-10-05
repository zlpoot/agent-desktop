"""D0-A offline contracts. Does not initialize Windows desktop or input."""
from pathlib import Path
import subprocess
import sys

result = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s",
                         str(Path(__file__).resolve().parents[1] / "spikes" / "local-workspace" / "tests"), "-v"])
sys.exit(result.returncode)
