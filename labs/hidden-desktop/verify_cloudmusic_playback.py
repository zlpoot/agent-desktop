"""Explicit one-shot real playback through the registered STDIO MCP, then cleanup.

No model call. This is a protocol/backend smoke check, not native client loading
or audible-sound validation. Reports and screenshots stay local and ignored.
"""
import argparse
import json
from pathlib import Path
import time
import tomllib
import uuid

from verify_cloudmusic_mcp import Client


def verify(song, artist):
    root = Path(__file__).resolve().parents[2]
    settings = tomllib.loads((root / '.codex/config.toml').read_text(encoding='utf-8'))
    server = settings['mcp_servers']['agent_desktop_lab_playback']
    expected = [str(root / 'labs/hidden-desktop/mcp_stdio.py'), '--real', '--profile', 'cloudmusic-playback']
    if server['args'] != expected or Path(server['cwd']).resolve() != root:
        raise ValueError('Installed MCP does not match the reviewed playback profile')
    output = root / '.artifacts/lab-tasks-playback' / (time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8]+'.json')
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {'passed': False, 'transport': 'registered-project-stdio-mcp', 'modelUsed': False,
              'mode': 'real', 'inputs': {'song': song, 'artist': artist},
              'requestId': 'real-play-'+uuid.uuid4().hex, 'calls': [], 'cleanup': {'closed': False}}
    client = Client(server)
    opened, job_id, finished = False, None, False

    def call(name, arguments=None):
        raw = client.rpc('tools/call', {'name': name, 'arguments': arguments or {}}, timeout=30)
        body = raw['structuredContent']
        report['calls'].append({'tool': name, 'arguments': arguments or {}, 'result': body})
        if body.get('ok') is not True:
            raise RuntimeError(name+': '+body.get('error', {}).get('code', 'call-failed'))
        return body

    try:
        client.rpc('initialize', {'protocolVersion': '2025-11-25', 'capabilities': {},
                                  'clientInfo': {'name': 'labs-playback-verifier', 'version': '1'}})
        client.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        report['tools'] = client.rpc('tools/list', {})['tools']
        listing = call('capabilities_list')
        if listing['mode'] != 'real' or [c['id'] for c in listing['capabilities']] != ['cloudmusic.open-and-play']:
            raise RuntimeError('Unexpected playback catalog')
        call('capability_describe', {'capabilityId': 'cloudmusic.open-and-play'})
        session = call('session_open'); opened = True
        report['sessionId'] = session['sessionId']
        receipt = call('task_start', {'capabilityId': 'cloudmusic.open-and-play', 'inputs': report['inputs'],
                                      'requestId': report['requestId']})
        job_id = report['jobId'] = receipt['jobId']
        deadline = time.monotonic()+240
        while True:
            job = call('task_status', {'jobId': job_id})['job']
            report['job'] = job
            if job['executionStatus'] != 'running':
                finished = True
                break
            if time.monotonic() >= deadline:
                raise RuntimeError('Task deadline exceeded; effects unknown, do not resubmit')
            time.sleep(.75)
        if (job['executionStatus'] != 'done' or job['effectStatus'] != 'observed'
                or job['requiresRecovery'] or job['error'] or job['previewWarning']):
            raise RuntimeError('Playback task failed: '+str(job.get('error')))
        if job['verification'] != {'status': 'manual-required', 'scope': 'real-owned-window-playback-state',
                                   'realWorldValidated': False}:
            raise RuntimeError('Incorrect playback acceptance or scope')
        expected_steps = ['cloudmusic.launch', 'cloudmusic.prepareSearch', 'cloudmusic.locateSearch',
                          'cloudmusic.fillSearch', 'cloudmusic.submitSearch', 'cloudmusic.openSong', 'cloudmusic.playSong']
        if [s['capability'] for s in job['steps']] != expected_steps or any(s['status'] != 'done' for s in job['steps']):
            raise RuntimeError('Incomplete playback workflow')
        calls = [entry['capability'] for entry in job['calls']]
        if calls.count('replay.value.set') != 1 or not 3 <= calls.count('replay.click') <= 4:
            raise RuntimeError('Unexpected dispatch count; do not repeat effects')
        observed = call('observation_get')['observation']
        report['observation'] = observed
        player = observed['playback']
        texts = [r['name'] for r in player['rows'] if r['role'] == 50020]
        pause = [r for r in player['rows'] if r['role'] == 50000 and r['autoId'] == 'btn_pc_minibar_play']
        if (not observed['ownedAppRunning'] or song not in texts or artist not in texts
                or len(pause) != 1 or pause[0]['name'] != 'pause' or player['state'] != 'playing'
                or player['audioAudibilityVerified'] is not False):
            raise RuntimeError('Current playback readback mismatch')
        report['readbackMatches'] = True
    except Exception as error:
        report['error'] = str(error)
    finally:
        if opened:
            try:
                if job_id and not finished:
                    report['job'] = call('task_status', {'jobId': job_id})['job']
                report['cleanup'] = call('session_close')['cleanup']
            except Exception as error:
                report['cleanupError'] = str(error)
        client.stop()
        report['serverExitCode'] = client.process.returncode
        report['serverStderr'] = ''.join(client.errors)
        report['passed'] = bool(report.get('readbackMatches') and report['cleanup']['closed']
                                and client.process.returncode == 0 and not report.get('error'))
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: report[key] for key in ('passed', 'mode', 'inputs', 'cleanup')}
                     | {'report': str(output), 'error': report.get('error')}, ensure_ascii=False))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--real', action='store_true', required=True,
                        help='Authorize one owned CloudMusic search/open/play and cleanup, no favorites/downloads.')
    parser.add_argument('--song', required=True)
    parser.add_argument('--artist', required=True)
    args = parser.parse_args()
    if not 1 <= len(args.song.strip()) <= 140 or not 1 <= len(args.artist.strip()) <= 40:
        parser.error('song must contain 1..140 characters and artist 1..40')
    raise SystemExit(verify(args.song.strip(), args.artist.strip()))
