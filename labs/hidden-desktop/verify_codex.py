"""Opt-in real Codex client check; every desktop task remains synthetic."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import time
import tomllib


def check_events(events):
    if any(event.get('item', {}).get('type') in ('command_execution', 'file_change', 'web_search') for event in events):
        raise ValueError('Verification must use MCP tools only, without shell, edits or web search')
    calls = [event['item'] for event in events if event.get('type') == 'item.completed'
             and event.get('item', {}).get('type') == 'mcp_tool_call']
    if not calls or len(calls) > 30:
        raise ValueError('Expected 1..30 real MCP tool calls')
    results = []
    for call in calls:
        if call.get('server') != 'agent_desktop_lab':
            raise ValueError('Unexpected MCP server')
        payload = call.get('result') or {}
        body = payload.get('structuredContent')
        if body is None:
            body = next((json.loads(item['text']) for item in payload.get('content', [])
                         if item.get('type') == 'text'), None)
        if not isinstance(body, dict) or body.get('ok') is not True:
            raise ValueError('MCP call did not succeed')
        results.append((call['tool'], body))
    groups = [[body for tool, body in results if tool == name] for name in
              ('session_open', 'task_start', 'task_status', 'observation_get', 'session_close')]
    opened, started, statuses, observed, closed = groups
    if not all(len(items) == 2 for items in (opened, started, observed, closed)):
        raise ValueError('Expected two complete sessions in one Codex run')
    if opened[0]['sessionId'] == opened[1]['sessionId']:
        raise ValueError('Second session must be fresh')
    for index, query in enumerate(('Codex integration first', 'Codex integration second')):
        session, job_id = opened[index]['sessionId'], started[index]['jobId']
        job = next((item['job'] for item in statuses if item['job']['jobId'] == job_id
                    and item['job']['executionStatus'] == 'done'), None)
        if job is None or job['sessionId'] != session or job['verification']['status'] != 'manual-required':
            raise ValueError('Missing completed job or manual acceptance was lost')
        state = observed[index]['observation']
        if (state['value'], state['submitted'], state['writes'], state['clicks']) != (query, query, 1, 1):
            raise ValueError('Independent synthetic readback mismatch')
        if closed[index]['sessionId'] != session or closed[index]['cleanup']['closed'] is not True:
            raise ValueError('Session cleanup was not confirmed')
    usage = [event['usage'] for event in events if event.get('type') == 'turn.completed']
    return {'passed': True, 'sessions': 2, 'mcpCalls': len(calls), 'usage': usage,
            'mode': 'real-codex-with-synthetic-backend', 'realApplicationValidated': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--real', action='store_true', required=True,
                        help='Explicitly authorize an actual Codex/model run; no real apps are used.')
    parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = root / '.artifacts/labs-mcp-codex' / time.strftime('%Y%m%d-%H%M%S')
    output.mkdir(parents=True, exist_ok=True)
    codex = shutil.which('codex')
    if not codex:
        raise SystemExit('Codex CLI is not installed.')
    # Read only the selected model name. Codex itself uses its existing login;
    # this script never opens auth.json or handles credentials.
    config = Path.home() / '.codex/config.toml'
    settings = tomllib.loads(config.read_text(encoding='utf-8')) if config.exists() else {}
    arguments = [codex, 'exec', '--ignore-user-config', '--ephemeral', '--sandbox', 'read-only',
                 '--strict-config', '--json', '-C', str(root),
                 '-c', 'model_reasoning_effort="low"', '-o', str(output / 'answer.txt'), '-']
    # The isolated CLI run does not load trusted-project state from user config.
    # Reuse exactly the installed project server as invocation-local overrides,
    # rather than enabling other user MCPs or changing global trust/permissions.
    project = tomllib.loads((root / '.codex/config.toml').read_text(encoding='utf-8'))
    for key, value in project['mcp_servers']['agent_desktop_lab'].items():
        arguments.extend(['-c', 'mcp_servers.agent_desktop_lab.' + key + '=' + json.dumps(value)])
    arguments.extend(['-c', 'mcp_servers.agent_desktop_lab.required=true'])
    if settings.get('model'):
        arguments.extend(['--model', settings['model']])
    installed_skill = (root / '.agents/skills/lab-tasks/SKILL.md').read_text(encoding='utf-8')
    prompt = '''Use $lab-tasks for a real Codex MCP integration check. The exact installed project
skill is supplied below, so no filesystem tool is needed. Do not use shell, modify files or run code/tests.
Use only agent_desktop_lab MCP tools for all task actions.
The backend must remain synthetic. Do not use any other MCP, network tools or real applications.
List capabilities and describe synthetic.form.submit, then perform these two distinct tasks sequentially:
1. session_open; task_start capabilityId=synthetic.form.submit, inputs={"query":"Codex integration first"},
   requestId=codex-first; task_status until done; observation_get; session_close.
2. On the SAME MCP connection, session_open again; task_start capabilityId=synthetic.form.submit,
   inputs={"query":"Codex integration second"}, requestId=codex-second; task_status until done;
   observation_get; session_close.
Keep the actual returned job IDs. Use no more than 30 MCP calls. Stop on any error or unknown effect,
without retrying inputs or fabricating results. Preserve manual-required; do not claim automatic acceptance.
Finally report both real job IDs, distinct session IDs, submitted values, execution and verification
states, and cleanup.closed. This request authorizes both synthetic sessions, not real app access.
'''
    prompt += '\n<installed_skill>\n' + installed_skill + '\n</installed_skill>\n'
    started = time.monotonic()
    try:
        completed = subprocess.run(arguments, input=prompt, capture_output=True, encoding='utf-8',
                                   timeout=240, cwd=root)
    except subprocess.TimeoutExpired as error:
        for name, value in (('events.jsonl', error.stdout), ('stderr.txt', error.stderr)):
            if isinstance(value, bytes):
                value = value.decode('utf-8', errors='replace')
            (output / name).write_text(value or '', encoding='utf-8')
        raise SystemExit('Codex verification exceeded 240 seconds; do not replay unknown tasks.') from None
    (output / 'events.jsonl').write_text(completed.stdout, encoding='utf-8')
    (output / 'stderr.txt').write_text(completed.stderr, encoding='utf-8')
    if completed.returncode:
        raise SystemExit('Codex verification failed; inspect ignored .artifacts/labs-mcp-codex logs.')
    events = [json.loads(line) for line in completed.stdout.splitlines() if line.startswith('{')]
    try:
        summary = check_events(events)
    except ValueError as error:
        raise SystemExit(str(error) + '; inspect ignored logs in ' + str(output)) from None
    summary.update(elapsedSeconds=round(time.monotonic() - started, 3), model=settings.get('model', 'Codex default'))
    (output / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
