"""Bounded, connection-owned task service over the existing JSON executor.

This module has no transport, model selection or native input entry point.
One service owns one backend; clients cannot supply session/OS ownership facts.
"""
import copy
import re
import threading
import uuid


class TaskError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def validate_arguments(value, schema):
    """Validate the closed JSON Schema subset used by this lab's tools/catalog.

    This is deliberately not a general JSON Schema implementation. Unsupported
    schema types fail closed; no coercion or extra properties are accepted.
    """
    kind = schema.get('type')
    if kind == 'object':
        if not isinstance(value, dict) or len(value) > schema.get('maxProperties', 16):
            raise TaskError('invalid-arguments')
        properties = schema.get('properties', {})
        if set(schema.get('required', [])) - value.keys():
            raise TaskError('invalid-arguments')
        for key, child in value.items():
            if not isinstance(key, str):
                raise TaskError('invalid-arguments')
            child_schema = properties.get(key, schema.get('additionalProperties', False))
            if not isinstance(child_schema, dict):
                raise TaskError('invalid-arguments')
            validate_arguments(child, child_schema)
    elif kind == 'string':
        if not isinstance(value, str) or not schema.get('minLength', 0) <= len(value) <= schema.get('maxLength', 512):
            raise TaskError('invalid-arguments')
        try:
            value.encode('utf-8')
        except UnicodeError:
            raise TaskError('invalid-arguments') from None
        if 'pattern' in schema and not re.fullmatch(schema['pattern'], value):
            raise TaskError('invalid-arguments')
    else:
        raise TaskError('unsupported-schema')


class TaskRuntime:
    MAX_TASKS = 32  # No eviction: request IDs remain reserved for this connection.

    def __init__(self, backend_factory):
        self.backend_factory = backend_factory
        self.backend = backend_factory()
        self.catalog = self.backend.catalog()
        self.session_id = None
        self.lock = threading.RLock()
        self.jobs = {}
        self.requests = {}
        self.active = None
        self.closed = True
        self.cleanup = None

    def metadata(self):
        return {'sessionId': self.session_id, 'mode': self.backend.mode,
                'closed': self.closed, 'maxTasks': self.MAX_TASKS,
                'realWorldValidated': False}

    def _open(self):
        if self.closed:
            raise TaskError('session-closed')

    def open(self):
        with self.lock:
            if not self.closed:
                return {**self.metadata(), 'opened': False}  # Never silently renew.
            if self.cleanup is not None and not self.cleanup['closed']:
                raise TaskError('cleanup-unconfirmed')
            if self.backend.closed:
                self.backend = self.backend_factory()
                self.catalog = self.backend.catalog()
            self.backend.open()
            self.session_id = uuid.uuid4().hex
            self.closed, self.cleanup = False, None
            return {**self.metadata(), 'opened': True}

    def _refresh(self):
        if self.active is not None:
            raw = self.backend.replay.status(self.active)
            self.jobs[self.active]['raw'] = raw
            self.jobs[self.active]['requiresRecovery'] = self.backend.replay.requires_reset
            if raw['status'] != 'running' and not self.backend.replay.busy():
                self.active = None

    def list_capabilities(self):
        with self.lock:
            entries = []
            for entry in self.catalog.values():
                availability, reason = self.backend.availability(entry['id'])
                entries.append({key: entry[key] for key in ('id', 'kind', 'title', 'mode')}
                               | {'availability': availability, 'reason': reason})
            return {**self.metadata(), 'capabilities': entries}

    def describe(self, capability_id):
        with self.lock:
            if capability_id not in self.catalog:
                raise TaskError('unknown-capability')
            entry = copy.deepcopy(self.catalog[capability_id])
            entry.pop('action')
            entry['availability'], entry['reason'] = self.backend.availability(capability_id)
            return {**self.metadata(), 'capability': entry}

    def start(self, capability_id, inputs, request_id):
        with self.lock:
            self._open()
            validate_arguments(request_id, {'type': 'string', 'minLength': 1, 'maxLength': 64,
                                            'pattern': r'[A-Za-z0-9_.-]+'})
            if not isinstance(capability_id, str) or capability_id not in self.catalog:
                raise TaskError('unknown-capability')
            descriptor = self.catalog[capability_id]
            validate_arguments(inputs, descriptor['inputSchema'])
            normalized = {key: value.strip() for key, value in inputs.items()}
            validate_arguments(normalized, descriptor['inputSchema'])
            fingerprint = (capability_id, normalized)
            # Duplicate starts return the old job, including failures. Never retry
            # side effects, evict keys, or interpret a fresh RPC ID as a fresh task.
            if request_id in self.requests:
                previous, job_id = self.requests[request_id]
                if previous != fingerprint:
                    raise TaskError('request-id-conflict')
                self._refresh()
                return {**self.metadata(), 'jobId': job_id, 'deduplicated': True}
            self._refresh()
            if self.active is not None or self.backend.replay.busy():
                raise TaskError('task-busy')
            if self.backend.replay.requires_reset:
                raise TaskError('session-recovery-required')
            if len(self.jobs) >= self.MAX_TASKS:
                raise TaskError('task-history-full')
            self.backend.guard()
            # The executor checks dependencies again before dispatch. First pin the
            # advertised definition here, including directly called sub-capabilities.
            try:
                self.backend.preflight(descriptor, normalized)
            except (ValueError, RuntimeError, OSError):
                raise TaskError('definition-preflight-failed') from None
            job_id = self.backend.replay.start(descriptor['action'], normalized)
            self.jobs[job_id] = {'capabilityId': capability_id, 'requestId': request_id,
                                 'sessionId': self.session_id, 'requiresRecovery': False,
                                 'raw': self.backend.replay.status(job_id)}
            self.requests[request_id] = (copy.deepcopy(fingerprint), job_id)
            self.active = job_id
            return {**self.metadata(), 'jobId': job_id, 'deduplicated': False}

    def status(self, job_id):
        with self.lock:
            if not isinstance(job_id, str) or job_id not in self.jobs:
                raise TaskError('job-not-found')
            self._refresh()
            record = self.jobs[job_id]
            raw = record['raw']
            calls = raw.get('calls', [])
            mutations = [call for call in calls if call['capability'] in (
                'replay.value.set', 'replay.click', 'env.app.launch', 'act.window.fit', 'act.type')]
            running = raw['status'] == 'running'
            failed = raw['status'] == 'failed'
            manual = not running and not failed and raw.get('verification', {}).get('status') == '待人工核对'
            unknown = bool(mutations) and (failed or running)
            verification = 'pending' if running else 'failed' if failed else 'manual-required' if manual else 'passed'
            error = raw.get('error')
            if error and not re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}', error):
                error = 'execution-failed'
            result = {'jobId': job_id, 'sessionId': record['sessionId'], 'capabilityId': record['capabilityId'],
                'requestId': record['requestId'], 'executionStatus': raw['status'],
                'effectStatus': 'unknown' if unknown else 'observed' if mutations else 'none',
                'verification': {'status': verification,
                    'scope': self.catalog[record['capabilityId']]['verificationScope'], 'realWorldValidated': False},
                'currentCall': calls[-1]['capability'] if running and calls else None,
                'calls': [{key: call[key] for key in ('capability', 'status', 'elapsedMs') if key in call}
                          for call in calls], 'error': error,
                'previewWarning': bool(raw.get('previewError')),
                'requiresRecovery': bool(record['requiresRecovery'])}
            if 'verifiedValue' in raw.get('output', {}):
                result['verifiedValue'] = raw['output']['verifiedValue']
            if 'workflow' in raw:
                result['steps'] = [{key: step[key] for key in ('id', 'capability', 'status')}
                                   for step in raw['workflow']['steps']]
            return {**self.metadata(), 'job': result}

    def observation(self):
        with self.lock:
            self._open()
            # No observation can interleave a task's input/verification sequence.
            self._refresh()
            if self.active is not None:
                raise TaskError('task-busy')
            return {**self.metadata(), 'observation': self.backend.observation()}

    def close(self, wait=False):
        with self.lock:
            if self.closed and self.cleanup is not None:
                return {**self.metadata(), 'cleanup': copy.deepcopy(self.cleanup)}
            self._refresh()
            if self.active is not None and not wait:
                raise TaskError('task-busy')
            # EOF drains the bounded fake task, then releases references. Explicit
            # close refuses busy; neither path pretends to cancel an in-flight call.
            try:
                self.cleanup = self.backend.close()
            except Exception:
                self.cleanup = {'closed': False, 'error': 'cleanup-unconfirmed'}
            self._refresh()
            self.closed = True
            return {**self.metadata(), 'cleanup': copy.deepcopy(self.cleanup)}
