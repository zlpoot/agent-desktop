"""Small tools-only MCP STDIO adapter. Synthetic by default, opt-in real profile.

Implements the 2025-06-18 / 2025-11-25 initialize, ping, tools/list and
tools/call subset. Does not advertise MCP tasks, cancellation, HTTP or sampling.
"""
import argparse
import copy
import json
import sys

from agent_runtime import TaskError, TaskRuntime, validate_arguments
from replay_contract import ReplayError
from synthetic_runtime import SyntheticBackend


MAX_MESSAGE_BYTES = 65536
VERSIONS = ('2025-11-25', '2025-06-18')
IDENTIFIER = {'type': 'string', 'minLength': 1, 'maxLength': 100, 'pattern': r'[A-Za-z][A-Za-z0-9_.-]*'}
JOB_ID = {'type': 'string', 'minLength': 32, 'maxLength': 32, 'pattern': r'[0-9a-f]{32}'}


def object_schema(properties=None, required=None):
    return {'type': 'object', 'properties': properties or {},
            'required': list(properties) if required is None and properties else required or [],
            'additionalProperties': False}


def output_schema(name):
    fields = {
        'capabilities_list': {'capabilities': {'type': 'array', 'maxItems': 4, 'items': {'type': 'object'}}},
        'capability_describe': {'capability': {'type': 'object', 'required': ['id', 'inputSchema', 'effects', 'verificationScope']}},
        'task_start': {'jobId': JOB_ID, 'deduplicated': {'type': 'boolean'}},
        'session_open': {'opened': {'type': 'boolean'}},
        'task_status': {'job': {'type': 'object', 'required': ['jobId', 'executionStatus', 'effectStatus', 'verification'],
            'properties': {'jobId': JOB_ID, 'executionStatus': {'enum': ['running', 'done', 'failed']},
                'effectStatus': {'enum': ['none', 'observed', 'unknown']},
                'verification': {'type': 'object', 'required': ['status', 'scope', 'realWorldValidated'],
                    'properties': {'status': {'enum': ['pending', 'passed', 'failed', 'manual-required']},
                                   'realWorldValidated': {'const': False}}}}}},
        'observation_get': {'observation': {'type': 'object', 'required': ['scope', 'pixels', 'value', 'submitted'],
                                          'properties': {'scope': {'const': 'synthetic-state'}, 'pixels': {'const': False}}}},
        'session_close': {'cleanup': {'type': 'object', 'required': ['closed'], 'properties': {'closed': {'type': 'boolean'}}}}
    }[name]
    properties = {'ok': {'type': 'boolean'}, 'sessionId': {'anyOf': [JOB_ID, {'type': 'null'}]}, 'mode': {'const': 'synthetic'},
                  'closed': {'type': 'boolean'}, 'maxTasks': {'type': 'integer', 'minimum': 1},
                  'realWorldValidated': {'const': False},
                  'error': {'type': 'object', 'required': ['code', 'retryAutomatically'],
                            'properties': {'code': {'type': 'string'}, 'retryAutomatically': {'const': False}}}, **fields}
    return {'type': 'object', 'properties': properties, 'required': ['ok'], 'additionalProperties': False,
            'oneOf': [{'properties': {'ok': {'const': True}},
                       'required': ['sessionId', 'mode', 'closed', 'maxTasks', 'realWorldValidated', *fields]},
                      {'properties': {'ok': {'const': False}}, 'required': ['error']}]}


def tool(name, description, properties=None, read_only=False, required=None):
    return {'name': name, 'description': description,
            'inputSchema': object_schema(properties, required),
            'outputSchema': output_schema(name),
            'annotations': {'readOnlyHint': read_only, 'destructiveHint': not read_only,
                            'idempotentHint': read_only or name in ('session_open', 'session_close'), 'openWorldHint': False}}


TOOLS = [
    tool('capabilities_list', 'List configured synthetic tasks. No real desktop or model access.', read_only=True),
    tool('capability_describe', 'Inspect task inputs, preconditions, effects and verification scope.',
         {'capabilityId': IDENTIFIER}, read_only=True),
    tool('session_open', 'Explicitly open a synthetic session and start its 300-second lease. An already open session is returned without renewal.'),
    tool('task_start', 'Start one registered synthetic JSON task. Keep requestId for deduplication; receipt is not completion.',
         {'capabilityId': IDENTIFIER,
          'inputs': {'type': 'object', 'maxProperties': 8,
                     'additionalProperties': {'type': 'string', 'maxLength': 512}},
          'requestId': {'type': 'string', 'minLength': 1, 'maxLength': 64, 'pattern': r'[A-Za-z0-9_.-]+'}}),
    tool('task_status', 'Read an owned job. Distinguish execution, verification and unknown effects. Does not retry.',
         {'jobId': JOB_ID}, read_only=True),
    tool('observation_get', 'Read current synthetic state while idle. Returns no real screenshot or action authority.', read_only=True),
    tool('session_close', 'Release this connection-owned synthetic session and bindings. Refuses while a task is running.')
]
TOOL_INDEX = {entry['name']: entry for entry in TOOLS}


def tools_for_mode(mode, search=False):
    entries = copy.deepcopy(TOOLS)
    if mode == 'synthetic':
        return entries
    descriptions = {
        'capabilities_list': 'List the configured CloudMusic fill/readback workflow and its four children. Real owned-desktop access; no model calls.',
        'session_open': 'Create an owned hidden-desktop session and start its 300-second lease. An active session is returned without renewal.',
        'task_start': 'Start one pinned CloudMusic JSON task. Launch/fill/readback only; no search submission or playback. Retain requestId and jobId.',
        'observation_get': 'Independently read the current owned search field and capture evidence while idle. Does not prove search or playback results.',
        'session_close': 'Release UIA on its owning thread and close owned application processes and hidden desktop. Refuses while busy.'}
    if search:
        descriptions.update(
            capabilities_list='List the pinned CloudMusic complete search workflow and its six children. No playback or favorites.',
            task_start='Start one pinned CloudMusic JSON search task. May submit search once; read results without opening songs, playback or favorites. Retain requestId/jobId.',
            observation_get='Read actual current matching result names and owned-window evidence while idle. Scoped to the first matching result in the declared region; not a complete result list.')
    for entry in entries:
        schema = entry['outputSchema']
        schema['properties']['mode'] = {'const': 'real'}
        entry['description'] = descriptions.get(entry['name'], entry['description'])
        entry['annotations']['openWorldHint'] = True
        if entry['name'] == 'capabilities_list':
            schema['properties']['capabilities']['maxItems'] = 7 if search else 5
        if entry['name'] == 'observation_get':
            schema['properties']['observation'] = {'type': 'object', 'required': ['scope', 'pixels', 'value'],
                'properties': {'scope': {'const': 'real-owned-window-search-results' if search else 'real-owned-window-input-readback'},
                               'pixels': {'const': False}, 'value': {'type': ['string', 'null']}}}
            if search:
                schema['properties']['observation']['properties']['results'] = {
                    'type': 'object', 'required': ['rows', 'selection', 'completeResultList', 'globalUnique'],
                    'properties': {
                        'rows': {'type': 'array', 'minItems': 2, 'maxItems': 2, 'items': {
                            'type': 'object', 'required': ['role', 'name'], 'additionalProperties': False,
                            'properties': {'role': {'const': 50020}, 'name': {'type': 'string', 'maxLength': 512}}}},
                        'selection': {'const': 'first-visible-match-in-declared-region'},
                        'completeResultList': {'const': False}, 'globalUnique': {'type': 'null'}}}
    return entries


class RpcError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


def result(payload, error=False):
    body = {'ok': not error, **payload}
    return {'content': [{'type': 'text', 'text': json.dumps(body, ensure_ascii=False)}],
            'structuredContent': body, 'isError': error}


class McpServer:
    def __init__(self, runtime):
        self.runtime = runtime
        self.tools = tools_for_mode(runtime.backend.mode, getattr(runtime.backend, 'search_enabled', False))
        self.tool_index = {entry['name']: entry for entry in self.tools}
        self.initialized = self.ready = False

    def call_tool(self, name, arguments):
        if not isinstance(name, str) or name not in self.tool_index:
            raise RpcError(-32602, 'Unknown tool')
        validate_arguments(arguments, self.tool_index[name]['inputSchema'])
        if name == 'capabilities_list':
            payload = self.runtime.list_capabilities()
        elif name == 'capability_describe':
            payload = self.runtime.describe(arguments['capabilityId'])
        elif name == 'task_start':
            payload = self.runtime.start(arguments['capabilityId'], arguments['inputs'], arguments['requestId'])
        elif name == 'task_status':
            payload = self.runtime.status(arguments['jobId'])
        elif name == 'session_open':
            payload = self.runtime.open()
        elif name == 'observation_get':
            payload = self.runtime.observation()
        else:
            payload = self.runtime.close()
        error = name == 'session_close' and not payload['cleanup']['closed']
        if error:
            payload['error'] = {'code': 'cleanup-unconfirmed', 'retryAutomatically': False}
        return result(payload, error)

    def dispatch(self, message):
        request_id = message.get('id') if isinstance(message, dict) else None
        try:
            if not isinstance(message, dict) or message.get('jsonrpc') != '2.0' \
                    or not isinstance(message.get('method'), str) \
                    or ('id' in message and (type(request_id) not in (int, str)
                                            or isinstance(request_id, str) and len(request_id) > 128)):
                request_id = None
                raise RpcError(-32600, 'Invalid Request')
            method, params = message['method'], message.get('params', {})
            if 'id' not in message:
                if method == 'notifications/initialized' and self.initialized:
                    self.ready = True
                return None  # Notifications never dispatch tools or create tasks.
            if not isinstance(params, dict):
                raise RpcError(-32602, 'Invalid params')
            if '_meta' in params:
                if not isinstance(params['_meta'], dict):
                    raise RpcError(-32602, 'Invalid request metadata')
                params = {key: value for key, value in params.items() if key != '_meta'}
            if method == 'initialize':
                if self.initialized:
                    raise RpcError(-32600, 'Already initialized')
                client = params.get('clientInfo')
                if not isinstance(params.get('protocolVersion'), str) or not isinstance(params.get('capabilities'), dict) \
                        or not isinstance(client, dict) or not isinstance(client.get('name'), str) \
                        or not isinstance(client.get('version'), str):
                    raise RpcError(-32602, 'Invalid initialize params')
                requested = params['protocolVersion']
                self.initialized = True
                payload = {'protocolVersion': requested if requested in VERSIONS else VERSIONS[0],
                           'capabilities': {'tools': {'listChanged': False}},
                           'serverInfo': {'name': 'agent-desktop-labs', 'version': '0.1.0'},
                           'instructions': ('Synthetic only. ' if self.runtime.backend.mode == 'synthetic' else
                                           'Real owned-desktop CloudMusic search and read-only results; no playback or favorites. '
                                           if getattr(self.runtime.backend, 'search_enabled', False) else
                                           'Real owned-desktop CloudMusic fill/readback only; no search submission or playback. ')
                                           + 'Inspect tasks, explicitly session_open before task_start, '
                                           'retain requestId/jobId, query completion, '
                                           'preserve manual acceptance and unknown effects, then close the session.'}
            elif method == 'ping':
                payload = {}
            elif not self.ready:
                raise RpcError(-32000, 'Initialize the connection first')
            elif method == 'tools/list':
                validate_arguments(params, object_schema())
                payload = {'tools': copy.deepcopy(self.tools)}
            elif method == 'tools/call':
                if set(params) - {'name', 'arguments', '_meta'}:
                    raise RpcError(-32602, 'Invalid tool call params')
                try:
                    payload = self.call_tool(params.get('name'), params.get('arguments', {}))
                except (TaskError, ReplayError) as error:
                    payload = result({'error': {'code': str(error), 'retryAutomatically': False}}, error=True)
            else:
                raise RpcError(-32601, 'Method not found')
            return {'jsonrpc': '2.0', 'id': request_id, 'result': payload}
        except RpcError as error:
            return {'jsonrpc': '2.0', 'id': request_id, 'error': {'code': error.code, 'message': error.message}}
        except TaskError:
            return {'jsonrpc': '2.0', 'id': request_id, 'error': {'code': -32602, 'message': 'Invalid params'}}
        except Exception:
            # Never echo backend paths, arbitrary exception text or environment.
            return {'jsonrpc': '2.0', 'id': request_id, 'error': {'code': -32603, 'message': 'Internal error; query original job before proceeding'}}


def reject_constant(value):
    raise ValueError('Non-JSON numeric constant')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate object key')
        result[key] = value
    return result


def serve(server, source, destination):
    while True:
        line = source.readline(MAX_MESSAGE_BYTES + 1)
        if not line:
            return 0
        oversized = len(line) > MAX_MESSAGE_BYTES
        try:
            if oversized:
                raise ValueError('Message too large')
            message = json.loads(line.decode('utf-8'), parse_constant=reject_constant, object_pairs_hook=unique_object)
            response = server.dispatch(message)
        except (ValueError, UnicodeError, RecursionError):
            response = {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'Invalid or oversized JSON message'}}
        if response is not None:
            destination.write((json.dumps(response, ensure_ascii=False, allow_nan=False) + '\n').encode('utf-8'))
            destination.flush()
        if oversized:
            return 1  # Do not buffer/drain an unbounded line or parse its tail.


def main():
    parser = argparse.ArgumentParser(description='Labs MCP STDIO. Synthetic unless an explicit real profile is selected.')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--fake', action='store_true', help='Explicit synthetic mode (also the default).')
    modes.add_argument('--real', action='store_true', help='Authorize native owned-desktop execution for this process.')
    parser.add_argument('--profile', choices=['cloudmusic-fill-search', 'cloudmusic-search'])
    args = parser.parse_args()
    if args.real != bool(args.profile):
        parser.error('--real and an explicit --profile must be specified together')
    if args.real:
        from real_backend import RealBackend
        factory = lambda: RealBackend(search=args.profile == 'cloudmusic-search')
    else:
        factory = SyntheticBackend
    try:
        runtime = TaskRuntime(factory)
    except (ValueError, RuntimeError, OSError):
        print('Backend definitions unavailable or invalid; inspect configured local learning before opening a session.', file=sys.stderr)
        return 1
    try:
        exit_code = serve(McpServer(runtime), sys.stdin.buffer, sys.stdout.buffer)
    finally:
        cleanup = runtime.close(wait=True)
    if not cleanup['cleanup']['closed']:
        print('Session cleanup unconfirmed.', file=sys.stderr)
        return 1
    return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
