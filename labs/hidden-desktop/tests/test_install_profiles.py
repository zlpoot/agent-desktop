"""Installer isolation checks; temporary paths only, no user's MCP or skills."""
from pathlib import Path
import sys
import tempfile
import tomllib
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from install_codex import install


class InstallProfilesTests(unittest.TestCase):
    def test_playback_is_separate_explicit_idempotent_and_preserves_other_profiles(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'labs/hidden-desktop/skills/lab-tasks/SKILL.md'
            source.parent.mkdir(parents=True)
            source.write_text('synthetic skill fixture',encoding='utf-8')
            install(root)
            install(root,real=True,search=True)
            config = root/'.codex/config.toml'
            previous = tomllib.loads(config.read_text(encoding='utf-8'))['mcp_servers']
            for arguments in ({'playback':True},{'real':True,'search':True,'playback':True}):
                with self.assertRaises(SystemExit): install(root,**arguments)
            self.assertEqual(tomllib.loads(config.read_text(encoding='utf-8'))['mcp_servers'],previous)
            install(root,real=True,playback=True)
            installed = config.read_text(encoding='utf-8')
            install(root,real=True,playback=True)
            self.assertEqual(config.read_text(encoding='utf-8'),installed)
            current = tomllib.loads(installed)['mcp_servers']
            self.assertEqual({name:current[name] for name in previous},previous)
            self.assertEqual(current['agent_desktop_lab_playback']['args'][-3:],['--real','--profile','cloudmusic-playback'])
            self.assertEqual(current['agent_desktop_lab_playback']['default_tools_approval_mode'],'prompt')
            config.write_text(installed.replace('cloudmusic-playback','unreviewed-profile'),encoding='utf-8')
            with self.assertRaises(SystemExit): install(root,real=True,playback=True)
            self.assertIn('unreviewed-profile',config.read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
