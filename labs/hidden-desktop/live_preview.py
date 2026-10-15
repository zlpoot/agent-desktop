"""只读、按需、限频预览。最多缓存两张 PNG；不保留帧队列或无限落盘。"""
from collections import OrderedDict
import threading
import time


class PreviewError(RuntimeError):
    pass


class LivePreview:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.RLock()
        self.capture_lock = threading.Lock()
        self.frames = OrderedDict()
        self.owner = None
        self.instance = None
        self.sequence = 0
        self.last_request = float('-inf')

    def clear(self):
        with self.lock:
            self.frames.clear()
            self.owner = self.instance = None

    def _current(self, desktop):
        return desktop and desktop.context and desktop is self.owner \
            and desktop.context['instanceId'] == self.instance

    def publish(self, desktop, info, image):
        with self.lock:
            if not desktop or not desktop.context or info['instanceId'] != desktop.context['instanceId']:
                raise PreviewError('preview-instance-changed')
            if not self._current(desktop):
                self.frames.clear()
                self.owner, self.instance = desktop, info['instanceId']
            self.sequence += 1
            info = {**info, 'sequence': self.sequence, 'transport': 'memory', 'retainedFrames': 2}
            self.frames[info['token']] = (info, image)
            ordered = sorted(self.frames.items(), key=lambda pair: pair[1][0]['capturedAtNs'])
            self.frames = OrderedDict(ordered[-2:])
            return info

    def evidence(self, desktop, info):
        image = desktop.consume_preview(info)
        return self.publish(desktop, info, image)

    def latest(self, desktop):
        with self.lock:
            if not self._current(desktop) or not self.frames:
                return None
            return dict(next(reversed(self.frames.values()))[0])

    def stats(self, desktop):
        with self.lock:
            return {'retainedFrames': len(self.frames) if self._current(desktop) else 0,
                    'frameLimit': 2, 'pendingFiles': len(desktop.preview_files) if desktop else 0,
                    'pendingFileLimit': 8, 'maxFramesPerSecond': 1}

    def get(self, desktop, token):
        with self.lock:
            if not self._current(desktop) or token not in self.frames:
                raise PreviewError('preview-expired')
            return self.frames[token]

    def capture(self, desktop):
        if not self.capture_lock.acquire(blocking=False):
            raise PreviewError('preview-busy')
        try:
            if self.clock() - self.last_request < 0.9:
                raise PreviewError('preview-rate-limited')
            self.last_request = self.clock()
            if desktop is None:
                raise PreviewError('hidden-desktop-not-open')
            info, image = desktop.capture_frame(allow_unrendered=False)
            return self.publish(desktop, info, image), image
        finally:
            self.capture_lock.release()
