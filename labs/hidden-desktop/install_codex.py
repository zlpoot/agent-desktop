"""Install this synthetic MCP and its thin skill into this repository only."""
from pathlib import Path
import shutil
import sys
import tomllib


def install(root):
    lab = root / 'labs/hidden-desktop'
    config = root / '.codex/config.toml'
    text = config.read_text(encoding='utf-8') if config.exists() else ''
    settings = tomllib.loads(text)
    expected = {'command': sys.executable, 'args': [str(lab / 'mcp_stdio.py'), '--fake'],
                'cwd': str(root), 'default_tools_approval_mode': 'approve'}
    current = settings.get('mcp_servers', {}).get('agent_desktop_lab')
    if current is not None and current != expected:
        raise SystemExit('agent_desktop_lab already has different settings; preserve and inspect them first.')
    if current is None:
        # Literal TOML strings preserve Windows backslashes. Values are local paths,
        # not shell code; reject the one delimiter the literal format cannot hold.
        paths = [expected['command'], *expected['args'], expected['cwd']]
        if any("'" in path or '\n' in path or '\r' in path for path in paths):
            raise SystemExit('Unsupported quote or newline in installation path.')
        text += ("\n[mcp_servers.agent_desktop_lab]\ncommand = '%s'\nargs = ['%s', '--fake']\ncwd = '%s'\n"
                 "# This server exposes synthetic state only. No global approval change.\n"
                 "default_tools_approval_mode = 'approve'\n") % (sys.executable, lab / 'mcp_stdio.py', root)
        tomllib.loads(text)
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text(text, encoding='utf-8')
    source = lab / 'skills/lab-tasks/SKILL.md'
    destination = root / '.agents/skills/lab-tasks/SKILL.md'
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    print('Installed project MCP agent_desktop_lab and project skill lab-tasks (synthetic only).')


if __name__ == '__main__':
    install(Path(__file__).resolve().parents[2])
