"""Synthetic semantic/effect-fence contracts only. Never instantiate Win32/COM."""
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'spikes/local-workspace'))
from netease_agent_input import MusicAgentInputs
from provider_worker import ProviderWorker
from policy import Blocked


class AgentInputTests(unittest.TestCase):
    def setUp(self):
        self.api, self.uia = Mock(), Mock()
        self.control = {'owner': 'agent', 'epoch': 1, 'stop': False, 'lease': time.monotonic() + 3}
        self.rows = [{'index': i, 'role': role, 'name': name, 'auto_id': name, 'class': 'synthetic',
                      'enabled': True, 'offscreen': False, 'rect': [0, 0, 10, 10]}
                     for i, (role, name) in enumerate([(50004, '搜索'), (50000, 'search'), (50019, '单曲')])]
        self.value = ''
        self.uia.observe.side_effect = lambda *args: [dict(row) for row in self.rows]
        self.uia.runtime_id.side_effect = lambda index: [7, index]
        self.uia.value.side_effect = lambda index: self.value
        self.inputs = MusicAgentInputs(self.api, self.uia, 42, {}, {'taskMode': 'agent'}, lambda: self.control, 'run', Mock())
        self.inputs.acknowledge(self.control)
        self.inputs.window_click = Mock(return_value=(44, {}))
        self.api.type_text.side_effect = lambda child, expected, text: setattr(self, 'value', text)

    def command(self, action, identifier='1', **changes):
        self.inputs.observe()
        return {'id': identifier, 'run_id': 'run', 'owner': 'agent', 'epoch': 1, 'action': 'task-action',
                'expires': time.monotonic() + 2, 'task_action': action,
                'observed_target': dict(self.inputs.rows[0 if action['target']['role'] == 'edit' else 1]), **changes}

    def test_dynamic_query_is_parameterized_and_fixed_script_never_starts(self):
        for artist, song in [('周杰伦', '晴天'), ('陈奕迅', '十年')]:
            self.value = ''
            action = {'kind': 'type', 'target': {'kind': 'role', 'role': 'edit'}, 'text': artist + ' ' + song}
            self.inputs.command(self.command(action, identifier=song))
            self.assertEqual(self.inputs.last['result'], 'APPLIED')
            self.assertEqual(self.value, artist + ' ' + song)
        self.inputs.command({'id': 'script', 'action': 'script'})
        self.inputs.step()
        self.assertFalse(self.inputs.started)
        self.assertEqual(self.inputs.last['result'], 'REJECTED')

    def test_favorite_unknown_and_arbitrary_coordinates_never_emit_input(self):
        for action in [
                {'kind': 'set_checked', 'target': {'kind': 'role', 'role': 'button', 'name': 'search'}, 'checked': True},
                {'kind': 'click', 'target': {'kind': 'coordinate', 'x': 1, 'y': 1}},
                {'kind': 'click', 'target': {'kind': 'role', 'role': 'button', 'name': '登录'}}]:
            command = {'id': str(len(self.inputs.seen)), 'run_id': 'run', 'owner': 'agent', 'epoch': 1,
                       'action': 'task-action', 'expires': time.monotonic() + 2, 'task_action': action}
            self.inputs.command(command)
            self.assertEqual(self.inputs.last['result'], 'REJECTED')
            self.assertEqual(self.inputs.last['effect'], 'none')
        self.inputs.window_click.assert_not_called()
        self.api.type_text.assert_not_called()

    def test_new_runtime_id_ambiguous_controls_and_stale_epoch_are_rejected(self):
        action = {'kind': 'click', 'target': {'kind': 'role', 'role': 'button', 'name': 'search'}}
        command = self.command(action)
        self.uia.runtime_id.side_effect = lambda index: [99, index]
        self.inputs.command(command)
        self.assertIn('identity_changed', self.inputs.last['reason'])
        self.uia.runtime_id.side_effect = lambda index: [7, index]
        self.rows.append({**self.rows[1], 'index': 3})
        self.inputs.command(self.command(action, '2'))
        self.assertIn('ambiguous', self.inputs.last['reason'])
        self.rows.pop()
        self.inputs.command(self.command(action, '3', epoch=0))
        self.assertEqual(self.inputs.last['effect'], 'none')
        self.inputs.window_click.assert_not_called()

    def test_expired_at_actual_effect_and_revoked_mid_effect_are_unknown_no_second_send(self):
        action = {'kind': 'click', 'target': {'kind': 'role', 'role': 'button', 'name': 'search'}}
        command = self.command(action)
        def expired(*_args):
            self.inputs.effect_deadline = time.monotonic() - 1
            self.inputs.check_input()
        self.inputs.window_click.side_effect = expired
        with self.assertRaisesRegex(Blocked, 'effect_unknown'):
            self.inputs.command(command)
        self.assertEqual(self.inputs.last['effect'], 'uncertain')
        with self.assertRaisesRegex(Blocked, 'duplicate'):
            self.inputs.command(command)
        self.assertEqual(self.inputs.window_click.call_count, 1)
        with self.assertRaisesRegex(Blocked, 'effect_unknown'):
            self.inputs.acknowledge({'owner': 'human', 'epoch': 2})

    def test_ordinary_rejection_before_effect_is_not_retried_as_a_toggle(self):
        action = {'kind': 'type', 'target': {'kind': 'role', 'role': 'edit', 'name': '搜索'}, 'text': '\n'}
        self.inputs.command(self.command(action))
        self.assertEqual(self.inputs.last['effect'], 'none')
        self.inputs.window_click.assert_not_called()


class BridgeActionTests(unittest.TestCase):
    def setUp(self):
        self.worker = ProviderWorker('synthetic-only')
        self.worker.controller = Mock()
        self.worker.controller.netease = {'taskMode': 'agent'}
        self.worker.controller.snapshot.return_value = {'status': 'ready', 'owner': 'agent', 'epoch': 1}
        self.worker.controller.task_action.return_value = {'ok': True, 'effect': 'dispatched', 'message': 'synthetic'}
        self.worker.controller.frame_packet.return_value = (b'synthetic', {'sequence': 1, 'heartbeat': time.monotonic()})
        self.worker.current_target_id = lambda: 'original'
        self.worker.run_id = 'run'
        self.worker.d0_epoch = 1
        self.worker.backend_instance_id = 'instance'
        self.worker.grant = {'owner': {'kind': 'agent'}, 'grantId': 'grant'}
        self.worker.observation = {'token': 'fresh', 'instance': 'instance', 'target': 'original', 'run': 'run',
            'grant': self.worker.grant, 'epoch': 1, 'sequence': 1, 'expires': time.monotonic() + 2,
            'uia': [{'role': 50000, 'name': 'search', 'enabled': True, 'offscreen': False, 'runtime_id': [7, 1]}]}
        self.args = {'run_id': 'run', 'epoch': 1, 'authority': self.worker.grant, 'observationToken': 'fresh',
                     'actionId': 'action', 'action': {'kind': 'click', 'target': {'kind': 'role', 'role': 'button', 'name': 'search'}}}

    def test_native_outcome_consumes_observation_and_action_identifier(self):
        self.assertEqual(self.worker.task_action(self.args)['effect'], 'dispatched')
        self.assertIsNone(self.worker.observation)
        self.assertIn('action', self.worker.task_action_ids)
        with self.assertRaises(Blocked): self.worker.task_action(self.args)
        self.assertEqual(self.worker.controller.task_action.call_count, 1)

    def test_stale_observation_and_missing_identity_never_enqueue(self):
        for key, value in [('expires', 0), ('target', 'replacement'), ('grant', {})]:
            before = self.worker.observation[key]
            self.worker.observation[key] = value
            with self.assertRaises(Blocked): self.worker.task_action(self.args)
            self.worker.observation[key] = before
        self.worker.observation['uia'][0]['runtime_id'] = None
        with self.assertRaisesRegex(Blocked, 'identity_unavailable'): self.worker.task_action(self.args)
        self.worker.controller.task_action.assert_not_called()

    def test_unknown_native_outcome_is_terminal(self):
        self.worker.controller.task_action.return_value = {'ok': False, 'effect': 'uncertain', 'message': 'synthetic'}
        self.worker.task_action(self.args)
        self.assertTrue(self.worker.stale)
        self.assertIn('action', self.worker.task_action_ids)


if __name__ == '__main__':
    unittest.main()
