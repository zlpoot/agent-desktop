"""Explicit owner of the bench runtime, replays and preview lifecycle."""
import threading

from capabilities import CAPABILITIES, MAX_LEASE, CapabilityError, CapabilityRuntime, _as_code
from hidden_desktop import Blocked
from learned_replay import LearnedReplay
from live_preview import LivePreview, PreviewError
from capability_contract import ContractLibrary
from replay_contract import validate_recipe
from hidden_desktop_lab.contracts.experiment import load_experiment
from app_startup import load_presets
from instruction_replay import InstructionLibrary
from hidden_desktop_lab.paths import LabPaths

PAGE_LEASE_SECONDS = 300


class BenchApplication:
    def __init__(self, paths, lease=PAGE_LEASE_SECONDS):
        if not 0 < lease <= MAX_LEASE:
            raise ValueError('invalid-lease')
        self.paths = paths
        self.replays = {}
        self._released_replays = set()
        self._closed = False
        self.lock = threading.RLock()
        self.lab = None
        try:
            self.lab = CapabilityRuntime(lease=lease)
            self.last = {"preview": None}
            self.preview = LivePreview()
            self.app_presets = load_presets(str(self.paths.root))

            self.experiment = load_experiment(str(self.paths.root))
            self.library = ContractLibrary(
                self.experiment.workflow, self.experiment.capabilities, validate_recipe,
                require_local=True, contracts_path=self.paths.capability_contracts)
            self.replay = LearnedReplay(
                self.lab, self.lock, self.experiment.template, self.experiment.learned,
                self.publish_preview, library=self.library,
                job_path=self.experiment.record, paths_path=self.experiment.paths)
            self.libraries = {'default': self.library}
            self.replays = {'default': self.replay}
            self.workflow_pages = {self.experiment.page_route: 'default'}
            self.workflow_links = []
            for configuration in self.experiment.additional_workflows:
                key = configuration['key']
                library = InstructionLibrary(configuration['workflow'], configuration['capabilities'], configuration['profiles'])
                definition = library.summary()  # 启动即校验全部引用、参数和版本配置；不执行应用动作。
                self.workflow_links.append({'route': configuration['route'], 'title': definition['workflow']['title']})
                self.libraries[key] = library
                self.replays[key] = LearnedReplay(
                    self.lab, self.lock, configuration['workflow'], configuration['workflow'],
                    self.publish_preview, library=library, job_path=configuration['record'])
                for route in (configuration['route'], *configuration['aliases']):
                    self.workflow_pages[route] = key
        except BaseException:
            self.close()
            raise


    def publish_preview(self, info):
        try:
            return self.preview.evidence(self.lab.desktop, info)
        except Blocked as error:
            raise _as_code(error) from error
        except PreviewError as error:
            raise CapabilityError('target-identity-changed', str(error)) from error


    def replay_busy(self):
        return any(replay.busy() for replay in self.replays.values())


    def snapshot(self, profile='default'):
        """声明 + 事实 + 可用性 + 日志，供页面渲染。"""
        with self.lock:
            facts = self.lab.facts()
            capabilities = []
            for capability in CAPABILITIES:
                entry = dict(capability)
                entry.update(self.lab.evaluate(capability, facts))
                capabilities.append(entry)
            desktop = self.lab.desktop
            return {
                "facts": facts,
                "actions": {"used": self.lab.actions, "max": self.lab.max_actions},
                "lease": {
                    "leaseSeconds": desktop.lifetime if desktop and desktop.context else None,
                    "remaining": desktop.remaining() if desktop and desktop.context else None,
                    "expired": bool(desktop and desktop.context and desktop.remaining() == 0),
                },
                "capabilities": capabilities,
                "log": self.lab.log[-120:],
                "last": self.last.get("invoke"),
                "lastPreview": self.preview.latest(desktop),
                "previewSession": desktop.context['instanceId'] if desktop and desktop.context else None,
                "previewTransport": self.preview.stats(desktop),
                "learned": self.replays[profile].summary(),
                "appLaunchPresets": self.app_presets,
                "manualFlow": self.workflow_links[0] if self.workflow_links else None,
                "workflowPage": {"route": self.experiment.page_route},
            }


    def auto_capture(self):
        """补充只读画面；传输文件读取后立即回收。"""
        desktop = self.lab.desktop
        if desktop is None or not desktop.context or desktop.blocked:
            return
        try:
            info, image = desktop.capture_frame(allow_unrendered=True)
            self.preview.publish(desktop, info, image)
        except Exception as error:
            self.lab.log_line('自动画面未取得：' + str(error), 'warning')
            return

    def close(self):
        if self._closed:
            return
        for replay in self.replays.values():
            if replay not in self._released_replays:
                replay.shutdown()
                self._released_replays.add(replay)
        with self.lock:
            if self.lab is not None and self.lab.desktop and self.lab.desktop.context:
                try:
                    self.lab.desktop.close()
                    print("退出前已清理隐藏桌面。", flush=True)
                except Exception as error:
                    print("退出前清理未确认：%s" % getattr(error, "errors", error), flush=True)
                    return
        self._closed = True


def create_application(paths=None, lease=PAGE_LEASE_SECONDS):
    """Read configured resources only when the caller explicitly assembles a bench."""
    return BenchApplication(paths if paths is not None else LabPaths.default(), lease)
