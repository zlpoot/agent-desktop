"""Explicit real CloudMusic MCP smoke check; fill/readback only, no model call."""
import argparse
import json
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import tomllib
import uuid


class Client:
    def __init__(self, settings):
        self.process = subprocess.Popen([settings['command'], *settings['args']], cwd=settings['cwd'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.responses, self.errors = queue.Queue(), []
        self.sequence = 0
        def read():
            for line in self.process.stdout:
                try:
                    self.responses.put(json.loads(line))
                except ValueError:
                    self.responses.put({'error': 'invalid-json-from-server'})
            self.responses.put({'error': 'server-disconnected'})
        def errors():
            for line in self.process.stderr:
                if len(self.errors) < 100:
                    self.errors.append(line.decode('utf-8', errors='replace'))
        self.readers = [threading.Thread(target=fn, daemon=True) for fn in (read, errors)]
        for reader in self.readers:
            reader.start()

    def send(self, message):
        self.process.stdin.write((json.dumps(message, ensure_ascii=False)+'\n').encode('utf-8'))
        self.process.stdin.flush()

    def rpc(self, method, params, timeout=20):
        self.sequence += 1
        self.send({'jsonrpc': '2.0', 'id': self.sequence, 'method': method, 'params': params})
        try:
            message = self.responses.get(timeout=timeout)
        except queue.Empty:
            raise RuntimeError('MCP response timed out; effects must be treated as unknown') from None
        if message.get('id') != self.sequence or 'error' in message:
            raise RuntimeError('MCP protocol failure; effects must be treated as unknown')
        return message['result']

    def stop(self):
        self.process.stdin.close()  # EOF requests backend cleanup even on a failed task.
        try:
            self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.process.terminate()  # Only our MCP child, never an existing user application.
            self.process.wait(timeout=5)
        for reader in self.readers:
            reader.join(timeout=2)
        self.process.stdout.close()
        self.process.stderr.close()


def verify(query):
    root = Path(__file__).resolve().parents[2]
    settings = tomllib.loads((root / '.codex/config.toml').read_text(encoding='utf-8'))
    server = settings['mcp_servers']['agent_desktop_lab_real']
    expected_args = [str(root / 'labs/hidden-desktop/mcp_stdio.py'), '--real', '--profile', 'cloudmusic-fill-search']
    if server['args'] != expected_args or Path(server['cwd']).resolve() != root:
        raise ValueError('Installed real MCP does not match the reviewed CloudMusic profile')
    output = root / '.artifacts/lab-tasks-real' / (time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8]+'.json')
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {'passed': False, 'transport': 'registered-project-stdio-mcp', 'modelUsed': False,
              'mode': 'real', 'query': query, 'calls': [], 'cleanup': {'closed': False}}
    client = Client(server)
    opened, job_id, finished = False, None, False
    def call(name, arguments=None):
        raw = client.rpc('tools/call', {'name': name, 'arguments': arguments or {}})
        body = raw['structuredContent']
        report['calls'].append({'tool': name, 'arguments': arguments or {}, 'result': body})
        if body.get('ok') is not True:
            raise RuntimeError(name+': '+body.get('error', {}).get('code', 'call-failed'))
        return body
    try:
        client.rpc('initialize', {'protocolVersion': '2025-11-25', 'capabilities': {},
                                  'clientInfo': {'name': 'labs-cloudmusic-verifier', 'version': '1'}})
        client.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        listing = call('capabilities_list')
        if listing['mode'] != 'real': raise RuntimeError('Expected real backend')
        call('capability_describe', {'capabilityId': 'cloudmusic.fill-search'})
        session = call('session_open'); opened = True
        report['sessionId'] = session['sessionId']
        call('observation_get')  # Open desktop, application not yet launched.
        receipt = call('task_start', {'capabilityId': 'cloudmusic.fill-search', 'inputs': {'query': query},
                                      'requestId': 'real-fill-'+uuid.uuid4().hex})
        job_id = report['jobId'] = receipt['jobId']
        deadline = time.monotonic()+240
        while True:
            job = call('task_status', {'jobId': job_id})['job']
            report['job'] = job
            if job['executionStatus'] != 'running':
                finished = True
                break
            if time.monotonic() >= deadline:
                raise RuntimeError('Task deadline exceeded; do not replay unknown input')
            time.sleep(.75)
        if job['executionStatus'] != 'done' or job['effectStatus'] == 'unknown':
            raise RuntimeError('Real task failed: '+str(job.get('error')))
        if job['verification']['status'] != 'passed' or job['verification']['scope'] != 'real-owned-window-input-readback':
            raise RuntimeError('Missing scoped input verification')
        observed = call('observation_get')['observation']
        report['observation'] = observed
        if observed['value'] != query or not observed['bound'] or not observed['ownedAppRunning']:
            raise RuntimeError('Independent current field readback mismatch')
        calls = [entry['capability'] for entry in job['calls']]
        # The pinned prepareSearch may collapse a detail page once. No submit
        # or playback child exists in this workflow/catalog.
        if calls.count('replay.value.set') != 1 or calls.count('replay.click') > 1:
            raise RuntimeError('Unexpected dispatch: review task effects before any further run')
        report['readbackMatches'] = True
    except Exception as error:
        report['error'] = str(error)
    finally:
        if opened:
            try:
                # Never claim a busy close is cleanup, nor restart/replay a job.
                if job_id and not finished:
                    job = call('task_status', {'jobId': job_id})['job']
                    report['job'] = job
                report['cleanup'] = call('session_close')['cleanup']
            except Exception as error:
                report['cleanupError'] = str(error)
        client.stop()
        report['serverExitCode'] = client.process.returncode
        report['serverStderr'] = ''.join(client.errors)
        report['passed'] = bool(report.get('readbackMatches') and report['cleanup']['closed']
                                and client.process.returncode == 0 and not report.get('error'))
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: report[key] for key in ('passed', 'mode', 'query', 'cleanup')}
                     | {'report': str(output), 'error': report.get('error')}, ensure_ascii=False))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--real', action='store_true', required=True,
                        help='Authorize one owned CloudMusic launch and search-field fill, then cleanup.')
    parser.add_argument('--query', default='接入测试')
    args = parser.parse_args()
    if not 1 <= len(args.query.strip()) <= 200:
        parser.error('query must contain 1..200 characters')
    raise SystemExit(verify(args.query.strip()))
