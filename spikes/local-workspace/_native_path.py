"""Bootstrap the repository-owned native package for standalone D0 scripts.

Only the import path lives here; native behavior and shared safety primitives
belong to src/native. Never resolve them relative to the caller's working dir.
"""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src/native'))
