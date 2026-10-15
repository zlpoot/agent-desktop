"""内存预览、传输文件回收、隔离与清理：仅合成窗口。"""
import copy
import sys
from pathlib import Path
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hidden_desktop import Blocked
from live_preview import LivePreview, PreviewError
from test_hidden_desktop import make


class LivePreviewTests(unittest.TestCase):
    def started(self, **kwargs):
        desktop, api, clock = make(**kwargs)
        desktop.open()
        desktop.start(sys.executable)
        self.addCleanup(desktop.close)
        return desktop, api, clock

    def test_many_frames_keep_two_in_memory_and_never_create_files(self):
        desktop, _api, clock = self.started()
        hub = LivePreview(clock)
        tokens = []
        for _ in range(30):
            info, body = hub.capture(desktop)
            tokens.append(info['token'])
            self.assertTrue(body.startswith(b'\x89PNG'))
            self.assertEqual(info['bytes'], len(body))
            clock.sleep(1)
        self.assertEqual(len(hub.frames), 2)
        self.assertFalse(desktop.preview_files)
        self.assertIsNone(desktop.preview_dir)
        self.assertEqual(hub.latest(desktop)['token'], tokens[-1])
        with self.assertRaises(PreviewError): hub.get(desktop, tokens[0])

    def test_evidence_consumed_after_validation_does_not_exhaust_eight_file_limit(self):
        desktop, _api, clock = self.started()
        hub = LivePreview(clock)
        for _ in range(20):
            info = desktop.capture()
            path = desktop.preview_path(info['token'])
            hub.evidence(desktop, info)
            self.assertFalse(path.exists())
            self.assertEqual(len(desktop.preview_files), 0)
        self.assertEqual(len(hub.frames), 2)

    def test_evidence_tampering_is_not_displayed_or_silently_consumed(self):
        desktop, _api, clock = self.started()
        hub = LivePreview(clock)
        info = desktop.capture()
        bad = {**info, 'sha256': 'a' * 64}
        with self.assertRaisesRegex(Blocked, 'preview_integrity_failed'):
            hub.evidence(desktop, bad)
        self.assertTrue(desktop.preview_path(info['token']).exists())
        self.assertEqual(len(hub.frames), 0)

    def test_full_file_pool_does_not_block_memory_frames_or_raise_existing_limit(self):
        desktop, _api, clock = self.started()
        hub = LivePreview(clock)
        for _ in range(8): desktop.capture()
        with self.assertRaisesRegex(Blocked, 'preview_pending_limit'): desktop.capture()
        hub.capture(desktop)
        self.assertEqual(len(desktop.preview_files), 8)

    def test_rate_limit_and_concurrent_capture_do_not_queue_more_frames(self):
        desktop, _api, clock = self.started()
        hub = LivePreview(clock)
        hub.capture(desktop)
        with self.assertRaisesRegex(PreviewError, 'rate-limited'): hub.capture(desktop)
        clock.sleep(1)
        hub.capture_lock.acquire()
        try:
            with self.assertRaisesRegex(PreviewError, 'preview-busy'): hub.capture(desktop)
        finally: hub.capture_lock.release()
        self.assertEqual(len(hub.frames), 1)

    def test_expiry_and_foreign_ownership_still_refuse_no_renewal(self):
        desktop, _api, clock = self.started()
        hub = LivePreview(clock)
        deadline = desktop.deadline
        clock.sleep(desktop.lifetime + 1)
        with self.assertRaisesRegex(Blocked, 'lease_expired'): hub.capture(desktop)
        self.assertEqual(desktop.deadline, deadline)
        self.assertFalse(hub.frames)
        foreign, _api, other_clock = self.started(break_job=True)
        with self.assertRaisesRegex(Blocked, 'target_outside_owned_job'):
            LivePreview(other_clock).capture(foreign)

    def test_cleanup_and_instance_change_invalidate_cached_frames(self):
        desktop, _api, clock = self.started()
        hub = LivePreview(clock)
        info, _ = hub.capture(desktop)
        desktop.close()
        self.assertIsNone(hub.latest(desktop))
        with self.assertRaises(PreviewError): hub.get(desktop, info['token'])
        other, _api, clock2 = self.started()
        newer = LivePreview(clock2)
        info, _ = newer.capture(other)
        other.context['instanceId'] = 'changed'
        with self.assertRaisesRegex(PreviewError, 'instance-changed'):
            newer.publish(other, info, b'old')

    def test_delayed_old_frame_cannot_replace_newer_frame(self):
        desktop, _api, clock = self.started()
        hub = LivePreview(clock)
        old, old_body = desktop.capture_frame()
        new, body = desktop.capture_frame()
        hub.publish(desktop, new, body)
        hub.publish(desktop, old, old_body)
        self.assertEqual(hub.latest(desktop)['token'], new['token'])

    def test_frame_capture_and_close_are_mutually_exclusive(self):
        desktop, api, _clock = self.started()
        entered, release, closed = threading.Event(), threading.Event(), threading.Event()
        capture = api.capture_window
        def held(hwnd):
            entered.set()
            if not release.wait(3): raise RuntimeError('synthetic-timeout')
            return capture(hwnd)
        api.capture_window = held
        errors = []
        def frame():
            try: desktop.capture_frame()
            except Exception as error: errors.append(error)
        capturing = threading.Thread(target=frame)
        capturing.start()
        self.assertTrue(entered.wait(2))
        closing = threading.Thread(target=lambda: (desktop.close(), closed.set()))
        closing.start()
        self.assertFalse(closed.wait(0.05))
        release.set()
        capturing.join(3)
        closing.join(3)
        self.assertTrue(closed.is_set())
        self.assertEqual(errors, [])
