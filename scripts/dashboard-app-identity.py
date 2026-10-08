"""Dashboard infrastructure identity only: never enumerate or inspect applications."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'guest'))
from app_discovery import installation_scope_id

try:
    print(json.dumps({'installationScopeId': installation_scope_id()}))
except Exception:
    # Do not expose machine GUID, user SID or Python diagnostics.
    print(json.dumps({'error': 'windows-app-identity-unavailable'}))
    sys.exit(1)
