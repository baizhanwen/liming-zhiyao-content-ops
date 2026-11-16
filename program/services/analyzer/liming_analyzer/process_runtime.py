"""Reusable analysis subprocess with bounded lifetime for every task/stage."""
from __future__ import annotations

import hashlib
import logging
import multiprocessing
import os
import shutil
import tempfile
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .api_client import AnalyzerApiError
from .platform_runtime import InstanceLock, ProcessTree, installation_root, prepare_processing_child
from .processing_health import processor_retirement_reasons, reset_processor_health
from .task_progress import ProgressObservations, observe, safe_observation
from .worker import ProcessingFailure, classify_worker_error

logger = logging.getLogger(__name__)
_CONTROL_RECOVERY_SECONDS = 8.0
_CONTROL_LEASE_MARGIN_SECONDS = 2.0


def _transient_control_error(error: Exception) -> bool:
    if isinstance(error, AnalyzerApiError):
        if error.status in {401, 403, 404, 409}:
            return False
        return (error.status in {408, 425, 429} or error.status >= 500
                or error.code == "INVALID_RESPONSE")
    return isinstance(error, OSError)


def _confirmed_control_lease(value: Mapping, job, now: float) -> float | None:
    """Convert a current owned-attempt receipt to a local monotonic deadline.

    Older control protocols can still run normally, but cannot authorize a
    grace period when connectivity is subsequently lost.
    """
    if type(value.get("attempt")) is not int or value["attempt"] != job.attempt_count:
        return None
    raw = value.get("leaseExpiresAt")
    if not isinstance(raw, str):
        return None
    try:
        expires = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if expires.tzinfo is None:
            return None
        remaining = (expires - datetime.now(timezone.utc)).total_seconds()
    except (ValueError, OverflowError):
        return None
    return now + remaining if remaining > _CONTROL_LEASE_MARGIN_SECONDS else None


def _processing_source_stamp() -> str:
    """Version imported source and its small shared protocol resources."""
    source_root = Path(__file__).resolve().parent
    digest = hashlib.sha256()
    sources = list(source_root.rglob("*.py"))
    sources.extend((source_root / "resources").glob("*.json"))
    for source in sorted(sources):
        digest.update(source.relative_to(source_root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(source.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


@dataclass(frozen=True)
class ProcessingLimits:
    initialization: float = 1800
    # Static resolution/download (15 min), browser fallback (15 min), and a
    # bounded margin for media validation and cleanup.
    download: float = 2100
    media: float = 900
    evidence: float = 1800
    speech: float | None = None
    subtitle: float | None = None
    visual: float | None = None
    artifacts: float = 600
    model: float = 1800
    task: float = 7200
    poll: float = 2

    @classmethod
    def from_environment(cls):
        values = {}
        for name in ("initialization", "download", "media", "evidence", "speech", "subtitle", "visual", "artifacts", "model", "task"):
            raw = os.environ.get(f"ANALYZER_TIMEOUT_{name.upper()}_SECONDS", "").strip()
            if raw:
                value = float(raw)
                if not 30 <= value <= 86400:
                    raise RuntimeError(f"ANALYZER_TIMEOUT_{name.upper()}_SECONDS must be between 30 and 86400")
                values[name] = value
        return cls(**values)

    def stage_seconds(self, phase: str, duration: float, profile: str):
        base = getattr(self, phase)
        if base is None:
            base = self.evidence  # Existing environment budgets remain compatible.
        # Long recordings get a larger finite budget; initialization is separate.
        factor = 2 if profile in {"max", "deep"} else 1
        extra = min(14400, max(0, duration - 600) * factor)
        return base + (extra if phase in {"media", "evidence", "speech", "subtitle", "visual", "model"} else 0)


def _build_processor(settings, client, monitor):
    from .__main__ import build_lazy_processor, configure_worker_logging
    configure_worker_logging()  # The spawned process starts with fresh logging settings.
    return build_lazy_processor(settings, client, monitor=monitor)


def _child_main(connection, settings, root, workspace, factory, owner_pid=None):
    # No model, FFmpeg, helper or task is started before the owner attaches us
    # to its Windows job object and sends the first command.
    try:
        if os.name != "nt":
            prepared = prepare_processing_child(owner_pid)
            connection.send(("prepared", prepared))
        first = connection.recv()
        if first != "attached":
            return
        with InstanceLock(Path(root), "processing", wait_ms=5000):
            from .bootstrap import build_client
            tempfile.tempdir = workspace
            client = build_client(settings) if settings is not None else None
            channel_lock = threading.Lock()
            def monitor(kind, value):
                with channel_lock:
                    connection.send((kind, value))
            processor = factory(settings, client, monitor)
            connection.send(("ready", None))
            while True:
                command, job = connection.recv()
                if command == "stop":
                    return
                reset_processor_health()
                observations = ProgressObservations()

                def heartbeat(status, progress, stage, observations=observations):
                    with channel_lock:
                        connection.send(("heartbeat", (status, progress, stage, observations.snapshot())))
                        response, value = connection.recv()
                    if response != "ok":
                        raise RuntimeError("Analyzer owner rejected heartbeat")
                    return value

                heartbeat.observe = observations.update
                try:
                    result = processor(job, heartbeat)
                    reasons = processor_retirement_reasons()
                    if reasons:
                        connection.send(("result_retire", (result, reasons)))
                        return
                    connection.send(("result", result))
                except Exception as error:  # noqa: BLE001 - safe classified process boundary
                    connection.send(("failure", classify_worker_error(error)))
    except (EOFError, BrokenPipeError):
        return
    finally:
        connection.close()


class IsolatedProcessor:
    def __init__(self, settings, client, *, root=None, limits=None, factory: Callable = _build_processor):
        self.settings = settings
        self.client = client
        self.root = Path(root or installation_root()).resolve()
        self.limits = limits or ProcessingLimits.from_environment()
        self.factory = factory
        self.process = self.connection = self.tree = self.workspace = None
        self.resources_released = True
        self._child_attached = False
        self._source_stamp = None

    def _start(self, job):
        context = multiprocessing.get_context("spawn")
        temporary_root = self.root / ".local" / "analyzer-work"
        temporary_root.mkdir(parents=True, exist_ok=True)
        self.workspace = Path(tempfile.mkdtemp(prefix="processor-", dir=temporary_root))
        (self.workspace / ".analyzer-owned").write_text("v1", encoding="ascii")
        self.connection, child = context.Pipe()
        self.tree = ProcessTree()
        self.process = context.Process(target=_child_main, args=(child, self.settings, str(self.root), str(self.workspace), self.factory, os.getpid()))
        try:
            self.process.start()
            child.close()
            if os.name == "nt":
                self.tree.attach(self.process.pid)
            else:
                deadline = time.monotonic() + 15
                while not self.connection.poll(0.2):
                    self.client.check_control(job)
                    if not self.process.is_alive() or time.monotonic() >= deadline:
                        raise ProcessingFailure("ANALYZER_PROCESS_START_FAILED", "分析处理进程未能建立隔离执行环境。")
                try:
                    kind, prepared = self.connection.recv()
                except (EOFError, OSError) as error:
                    raise ProcessingFailure("ANALYZER_PROCESS_START_FAILED", "分析处理进程未能建立隔离执行环境。") from error
                if kind != "prepared":
                    raise ProcessingFailure("ANALYZER_PROCESS_START_FAILED", "分析处理进程未能建立隔离执行环境。")
                self.tree.attach(self.process.pid, prepared)
            self._child_attached = True
            self._send("attached")
            deadline = time.monotonic() + 15
            while not self.connection.poll(0.2):
                self.client.check_control(job)
                if time.monotonic() >= deadline:
                    raise ProcessingFailure("ANALYZER_PROCESS_START_FAILED", "分析处理进程未能启动，请查看主机运行状态。")
            if self.connection.recv()[0] != "ready":
                raise ProcessingFailure("ANALYZER_PROCESS_START_FAILED", "分析处理进程未能启动，请查看主机运行状态。")
            # A ready child owns the processing mutex, so older marked
            # workspaces belong to exited children. Cleanup cannot delay the
            # cancellation watchdog.
            orphan_candidates = tuple(candidate for candidate in temporary_root.glob("processor-*") if candidate != self.workspace)
            threading.Thread(target=self._clean_orphans, args=(orphan_candidates,), daemon=True, name="analyzer-workspace-cleanup").start()
        except BaseException:
            self.close()
            raise

    def _clean_orphans(self, candidates):
        expected_parent = (self.root / ".local" / "analyzer-work").resolve()
        for candidate in candidates:
            if candidate == self.workspace or candidate.resolve().parent != expected_parent:
                continue
            try:
                if (candidate / ".analyzer-owned").read_text(encoding="ascii") == "v1":
                    shutil.rmtree(candidate, ignore_errors=True)
            except OSError:
                continue

    def close(self):
        if self.tree:
            self.tree.close()  # kill the whole owned tree, including native helpers
            self.tree = None
        if self.process:
            if self.process.pid is not None and not self._child_attached and self.process.is_alive():
                # This exact unreaped multiprocessing child has not received
                # permission to start business work. Recover failed handshakes.
                self.process.terminate()
                self.process.join(2)
                if self.process.is_alive():
                    self.process.kill()
            if self.process.pid is not None:
                self.process.join(5)
            if self.process.pid is not None and self.process.is_alive():
                # Fail closed: do not start another task while the old process lives.
                raise SystemExit("Analyzer process could not be stopped; refusing to run another task")
            self.process.close()
            self.process = None
            self._child_attached = False
        if self.connection:
            self.connection.close()
            self.connection = None
        if self.workspace:
            expected_parent = (self.root / ".local" / "analyzer-work").resolve()
            if self.workspace.resolve().parent != expected_parent:
                raise RuntimeError("Refusing to clean a workspace outside analyzer-work")
            shutil.rmtree(self.workspace, ignore_errors=True)
            self.workspace = None
        self.resources_released = True
        self._source_stamp = None

    def _send(self, value):
        try:
            self.connection.send(value)
        except (EOFError, OSError) as error:
            raise ProcessingFailure("ANALYZER_PROCESS_CRASHED", "分析处理进程通信中断，已释放资源，后续任务将继续。") from error

    def __call__(self, job, heartbeat):
        # Check only between jobs. A running task keeps its existing processor
        # and workspace even when code is updated while it is working.
        source_stamp = _processing_source_stamp()
        if self.process is not None and self._source_stamp != source_stamp:
            logger.info("Analyzer source changed; restarting idle processing subprocess")
            self.close()
        self.resources_released = False
        if self.process is None:
            self._start(job)
            self._source_stamp = source_stamp
        started = phase_started = time.monotonic()
        phase = "initialization"
        phase_elapsed = {}
        # A cloud-vision branch may keep running while the owner advances
        # speech/checkpoint phases. Its finite budget must survive those
        # transitions and repeated start notifications.
        branch_started: dict[str, float] = {}
        branch_elapsed: dict[str, float] = {}
        duration = 0.0
        next_control = started
        control_confirmed_at = None
        confirmed_lease_deadline = None
        control_recovery_deadline = None
        control_failures = 0
        pending_result = None

        def control_unavailable():
            return ProcessingFailure("ANALYZER_CONTROL_UNAVAILABLE",
                "分析服务暂时无法确认任务执行权，已安全停止并释放资源。请确认工作台服务正常后，从已有检查点重试。")

        def deliver_result(kind, value):
            # A synchronous control request or pipe wait may have consumed the
            # remaining budget since the outer loop's previous check.
            check_budgets()
            if kind == "result_retire":
                result, reasons = value
                logger.warning("Retiring processing child after resource cleanup warning: %s", ",".join(reasons))
                self.close()
                return result
            if not self.process.is_alive():
                self.close()
            else:
                self.resources_released = True
            return value

        def change_phase(new_phase):
            nonlocal phase, phase_started
            if new_phase == phase:
                return
            now = time.monotonic()
            phase_elapsed[phase] = phase_elapsed.get(phase, 0.0) + now - phase_started
            logger.info("Analyzer stage %s finished interval; cumulative_elapsed=%.1fs", phase, phase_elapsed[phase])
            phase, phase_started = new_phase, now
            logger.info("Analyzer stage %s started; budget=%.1fs", phase,
                        self.limits.stage_seconds(phase, duration, job.analysis_profile))

        def check_budgets():
            now = time.monotonic()
            if now - started > self.limits.task + min(14400, duration * 2):
                raise ProcessingFailure("ANALYZER_TASK_TIMEOUT", "分析超过本条任务的总时限，已回收处理进程；可从已有检查点重试。")
            elapsed = phase_elapsed.get(phase, 0.0) + now - phase_started
            budget = self.limits.stage_seconds(phase, duration, job.analysis_profile)
            if elapsed > budget:
                logger.error("Analyzer stage timeout: phase=%s elapsed=%.1fs budget=%.1fs", phase, elapsed, budget)
                raise ProcessingFailure("ANALYZER_STAGE_TIMEOUT", f"分析阶段 {phase} 超过处理时限（{round(elapsed)}秒 / {round(budget)}秒），已回收处理进程；可从已有检查点重试。")
            for branch, began in branch_started.items():
                branch_used = branch_elapsed.get(branch, 0.0) + now - began
                branch_budget = self.limits.stage_seconds(branch, duration, job.analysis_profile)
                if branch_used > branch_budget:
                    logger.error("Analyzer parallel branch timeout: branch=%s elapsed=%.1fs budget=%.1fs",
                                 branch, branch_used, branch_budget)
                    raise ProcessingFailure("ANALYZER_STAGE_TIMEOUT", f"分析阶段 {branch} 超过处理时限（{round(branch_used)}秒 / {round(branch_budget)}秒），已回收处理进程；可从已有检查点重试。")

        try:
            self._send(("run", job))
            while True:
                now = time.monotonic()
                check_budgets()
                if control_recovery_deadline is not None and now >= control_recovery_deadline:
                    logger.error("Analyzer control verification unavailable: source=control recovery_expired=true failures=%d", control_failures)
                    raise control_unavailable()
                if now >= next_control:
                    # Read-only control probe does not change the job version.
                    try:
                        owned = self.client.check_control(job)
                    except Exception as error:
                        if not _transient_control_error(error):
                            raise
                        check_budgets()
                        control_failures += 1
                        logger.warning("Analyzer control verification interrupted: source=control error_type=%s status=%s code=%s failures=%d",
                            type(error).__name__, getattr(error, "status", None),
                            getattr(error, "code", "CONTROL_TRANSPORT_ERROR"), control_failures)
                        if control_recovery_deadline is None:
                            if control_confirmed_at is None or confirmed_lease_deadline is None:
                                raise control_unavailable() from error
                            control_recovery_deadline = min(control_confirmed_at + _CONTROL_RECOVERY_SECONDS,
                                confirmed_lease_deadline - _CONTROL_LEASE_MARGIN_SECONDS)
                        if time.monotonic() >= control_recovery_deadline:
                            raise control_unavailable() from error
                    else:
                        check_budgets()
                        confirmed_at = time.monotonic()
                        if control_recovery_deadline is not None and confirmed_at >= control_recovery_deadline:
                            raise control_unavailable()
                        if control_failures:
                            logger.info("Analyzer control verification recovered: source=control failures=%d", control_failures)
                        control_confirmed_at = confirmed_at
                        confirmed_lease_deadline = _confirmed_control_lease(owned, job, confirmed_at)
                        control_recovery_deadline = None
                        control_failures = 0
                        if pending_result is not None:
                            return deliver_result(*pending_result)
                    next_control = time.monotonic() + self.limits.poll
                    if control_recovery_deadline is not None:
                        next_control = min(next_control, control_recovery_deadline)
                if pending_result is not None:
                    # A retiring child may close its pipe after sending the
                    # result. Keep checking ownership/watchdogs instead of
                    # treating that expected EOF as a new processing failure.
                    time.sleep(min(0.05, self.limits.poll))
                    continue
                if self.connection.poll(min(0.2, self.limits.poll)):
                    try:
                        kind, value = self.connection.recv()
                    except (EOFError, OSError) as error:
                        raise ProcessingFailure("ANALYZER_PROCESS_CRASHED", "分析处理进程异常退出，已释放资源，后续任务将继续。") from error
                    if kind == "heartbeat":
                        if not isinstance(value, (tuple, list)) or len(value) not in {3, 4}:
                            raise ProcessingFailure("ANALYZER_PROCESS_CRASHED", "分析处理进程返回无效状态，已释放资源。")
                        status, progress, stage = value[:3]
                        observation = safe_observation(value[3]) if len(value) == 4 else None
                        if observation is not None:
                            observe(heartbeat, observation["phase"], **observation["metrics"])
                        new_phase = "initialization" if "初始化本地分析模型" in stage else {
                            "downloading": "download", "processing": "media", "transcribing": "evidence",
                            "extracting": "artifacts", "analyzing": "model",
                        }.get(status, phase)
                        # Public status stays 'transcribing' for these evidence
                        # stages. It must not undo the child's precise boundary.
                        if new_phase == "evidence" and phase in {"speech", "subtitle", "visual", "artifacts"}:
                            new_phase = phase
                        if new_phase == "media" and phase == "artifacts":
                            new_phase = phase
                        change_phase(new_phase)
                        current = heartbeat(status, progress, stage)
                        self._send(("ok", current))
                    elif kind == "duration":
                        duration = max(0, min(86400, float(value)))
                    elif kind == "phase" and value in {"download", "media", "speech", "subtitle", "visual", "artifacts", "model"}:
                        change_phase(value)
                    elif kind == "branch_start" and value in {"speech", "visual"}:
                        if value not in branch_started:
                            branch_started[value] = time.monotonic()
                            logger.info("Analyzer parallel branch %s started; prior_elapsed=%.1fs budget=%.1fs",
                                        value, branch_elapsed.get(value, 0.0),
                                        self.limits.stage_seconds(value, duration, job.analysis_profile))
                    elif kind == "branch_end" and value in {"speech", "visual"}:
                        began = branch_started.pop(value, None)
                        if began is not None:
                            branch_elapsed[value] = branch_elapsed.get(value, 0.0) + time.monotonic() - began
                            logger.info("Analyzer parallel branch %s finished; cumulative_elapsed=%.1fs",
                                        value, branch_elapsed[value])
                    elif kind in {"result", "result_retire"} and branch_started:
                        raise ProcessingFailure("ANALYZER_PROCESS_CRASHED", "分析处理分支尚未退出，已回收处理进程；可从已有检查点重试。")
                    elif kind == "result":
                        if control_recovery_deadline is not None:
                            pending_result = (kind, value)
                            logger.info("Analyzer result awaits ownership confirmation: source=control")
                        else:
                            return deliver_result(kind, value)
                    elif kind == "result_retire":
                        if control_recovery_deadline is not None:
                            pending_result = (kind, value)
                            logger.info("Analyzer result awaits ownership confirmation: source=control")
                        else:
                            return deliver_result(kind, value)
                    elif kind == "failure":
                        raise ProcessingFailure(*value)
                elif not self.process.is_alive() and pending_result is None:
                    raise ProcessingFailure("ANALYZER_PROCESS_CRASHED", "分析处理进程异常退出，后续任务将继续；请检查内存和媒体依赖。")
        except BaseException:
            self.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()
