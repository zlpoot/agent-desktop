"""Install project MCP profiles and the thin skill; real execution is opt-in."""
import argparse
from pathlib import Path
import shutil
import sys
import tomllib


def install(root, real=False, search=False, playback=False):
    if (search or playback) and not real:
        raise SystemExit('--search/--playback requires --real')
    if search and playback:
        raise SystemExit('--search and --playback are separate profiles')
    lab = root / 'labs/hidden-desktop'
    config = root / '.codex/config.toml'
    text = config.read_text(encoding='utf-8') if config.exists() else ''
    settings = tomllib.loads(text)
    name = 'agent_desktop_lab_playback' if playback else 'agent_desktop_lab_search' if search else 'agent_desktop_lab_real' if real else 'agent_desktop_lab'
    arguments = ['--real', '--profile', 'cloudmusic-playback' if playback else 'cloudmusic-search' if search else 'cloudmusic-fill-search'] if real else ['--fake']
    expected = {'command': sys.executable, 'args': [str(lab / 'mcp_stdio.py'), *arguments],
                'cwd': str(root), 'default_tools_approval_mode': 'prompt' if real else 'approve'}
    current = settings.get('mcp_servers', {}).get(name)
    if current is not None and current != expected:
        raise SystemExit(name + ' already has different settings; preserve and inspect them first.')
    if current is None:
        # Literal TOML strings preserve Windows backslashes. Values are local paths,
        # not shell code; reject the one delimiter the literal format cannot hold.
        paths = [expected['command'], *expected['args'], expected['cwd']]
        if any("'" in path or '\n' in path or '\r' in path for path in paths):
            raise SystemExit('Unsupported quote or newline in installation path.')
        encoded_args = ', '.join("'" + value + "'" for value in expected['args'])
        text += ("\n[mcp_servers.%s]\ncommand = '%s'\nargs = [%s]\ncwd = '%s'\n"
                 "default_tools_approval_mode = '%s'\n") % (
                     name, sys.executable, encoded_args, root, expected['default_tools_approval_mode'])
        tomllib.loads(text)
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text(text, encoding='utf-8')
    source = lab / 'skills/lab-tasks/SKILL.md'
    destination = root / '.agents/skills/lab-tasks/SKILL.md'
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    print('Installed project MCP ' + name + ' and project skill lab-tasks. Restart MCP in Codex to load the tools.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--real', action='store_true', help='Register the explicit CloudMusic real profile, with normal tool approval.')
    parser.add_argument('--search', action='store_true', help='With --real, register complete search and read-only matching results, without playback.')
    parser.add_argument('--playback', action='store_true', help='With --real, register the complete explicitly authorized playback workflow; no favorites/downloads.')
    args = parser.parse_args()
    install(Path(__file__).resolve().parents[2], args.real, args.search, args.playback)
