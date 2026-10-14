"""Opt-in dynamic search primitives in the SAME D0 OS worker. No favorite mutation yet.

Agent Loop chooses each semantic action. This module never plans a song, starts a
fixed script, sends global input, or interprets an ACK as a favorite-state proof.
"""
import time
from netease_input import MusicInputs, ROLES
from policy import Blocked, validate_epoch


def require_medium_process(pid):
    """Read the owned process token; never infer elevation from the launcher's token."""
    import win32api
    import win32security
    process = win32api.OpenProcess(0x1000, False, pid)
    token = None
    try:
        token = win32security.OpenProcessToken(process, win32security.TOKEN_QUERY)
        elevated = bool(win32security.GetTokenInformation(token, win32security.TokenElevation))
        sid = win32security.GetTokenInformation(token, win32security.TokenIntegrityLevel)[0]
        integrity = sid.GetSubAuthority(sid.GetSubAuthorityCount() - 1)
        if elevated or integrity != 8192:
            raise Blocked('music_task_requires_medium_owned_process')
        return elevated
    finally:
        if token:
            token.Close()
        process.Close()


class MusicAgentInputs(MusicInputs):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.effect_deadline = None
        self.task_effects = 0

    def check_input(self):
        super().check_input()
        if self.effect_deadline is not None and time.monotonic() >= self.effect_deadline:
            raise Blocked('workspace_observation_expired_at_effect')

    def observe(self):
        self.rows = self.uia.observe(self.publish, ROLES)
        if len(self.rows) > 500:
            raise Blocked('music_task_uia_budget_exhausted')
        for row in self.rows:
            row['runtime_id'] = self.uia.runtime_id(row['index'])
            if row['role'] == 50004:
                row['value'] = self.uia.value(row['index'])
                row['value_complete'] = True
        if self.observe_sink:
            self.observe_sink(self.rows)
        return self.rows

    def step(self):
        # Dynamic Task mode cannot start/resume the legacy song/play script.
        pass

    def command(self, command):
        self.last = {'id': command.get('id'), 'result': 'REJECTED', 'effect': 'none'}
        identifier = command.get('id')
        if not isinstance(identifier, str) or identifier in self.seen or len(self.seen) >= 80:
            raise Blocked('duplicate_or_unbounded_commands')
        self.seen.add(identifier)
        if command.get('action') != 'task-action':
            self.last['reason'] = 'dynamic_task_requires_semantic_action'
            return
        try:
            if command.get('run_id') != self.run_id or time.monotonic() >= command.get('expires', 0):
                raise Blocked('stale_or_expired_command')
            validate_epoch(command.get('owner'), command.get('epoch'), self.read_control())
            if self.owner != 'agent':
                raise Blocked('agent_music_required')
            self.effect_deadline = command['expires']
            self.observe()
            self.check_input()
            action = command.get('task_action')
            if not isinstance(action, dict):
                raise Blocked('semantic_music_action_required')
            target = action.get('target')
            if (not isinstance(target, dict) or not {'kind', 'role'} <= set(target) <= {'kind', 'role', 'name'} or target['kind'] != 'role' or
                    not target.get('name') and not (action.get('kind') == 'type' and target['role'] == 'edit')):
                raise Blocked('semantic_music_target_required')
            if action.get('kind') == 'set_checked':
                raise Blocked('netease_favorite_state_unavailable')
            roles = {'edit': 50004, 'button': 50000, 'tab': 50019}
            row = self.one(lambda item: item['role'] == roles.get(target['role']) and
                           (target.get('name') is None or item['name'] == target['name']),
                           'music_target_missing_or_ambiguous')
            observed = command.get('observed_target')
            if not isinstance(observed, dict) or any(row.get(key) != observed.get(key) for key in
                    ('runtime_id', 'role', 'name', 'auto_id', 'class', 'rect')) or not row.get('runtime_id'):
                raise Blocked('music_target_identity_changed_at_effect')
            if action.get('kind') == 'type' and target['role'] == 'edit' and set(action) == {'kind', 'target', 'text'}:
                text = action['text']
                if not isinstance(text, str) or not 1 <= len(text) <= 161 or any(ord(c) < 32 or ord(c) > 65535 for c in text):
                    raise Blocked('netease_bounded_bmp_query_required')
                if row != self.editor():
                    raise Blocked('music_search_editor_unavailable')
                self.config['query'] = text
                self.pending_effect = True
                self.type_query(row)
            elif action.get('kind') == 'click' and set(action) == {'kind', 'target'} and (
                    target['role'] == 'button' and target['name'] == 'search' or
                    target['role'] == 'tab' and target['name'] == '单曲'):
                self.pending_effect = True
                self.window_click(row)
            else:
                raise Blocked('music_agent_action_not_supported')
            self.check_input()
            self.pending_effect = False
            self.task_effects += 1
            self.last.update(result='APPLIED', effect='dispatched')
        except Exception as error:
            self.last['reason'] = str(error) if isinstance(error, Blocked) else 'native_music_action_failed'
            if self.pending_effect:
                self.last['effect'] = 'uncertain'
                raise Blocked('music_input_effect_unknown_fail_closed') from error
        finally:
            self.effect_deadline = None

    def view(self):
        return {'owner_ack': self.owner, 'epoch_ack': self.epoch, 'last_command': self.last,
                'input': 'RUNNING' if self.task_effects else 'NOT_RUN', 'input_ready': True, 'stage': 'agent_search',
                'agent_started': False, 'agent_progress': 0, 'agent_total': 0,
                'favorite_state': 'UNKNOWN', 'favorite_effect': 'UNAVAILABLE'}
