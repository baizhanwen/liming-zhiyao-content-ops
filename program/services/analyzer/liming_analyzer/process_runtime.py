"""Reusable analysis subprocess with bounded lifetime for every task/stage."""
from __future__ import annotations

import multiprocessing
import os
import shutil
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .windows_runtime import InstanceLock, ProcessTree, installation_root
from .worker import ProcessingFailure, classify_worker_error


@dataclass(frozen=True)
class ProcessingLimits:
    initialization: float = 1800
    download: float = 900
    media: float = 900
    evidence: float = 1800
    artifacts: float = 600
    model: float = 1800
    task: float = 7200
    poll: float = 2

    @classmethod
    def from_environment(cls):
        values = {}
        for name in ("initialization", "download", "media", "evidence", "artifacts", "model", "task"):
            raw = os.environ.get(f"ANALYZER_TIMEOUT_{name.upper()}_SECONDS", "").strip()
            if raw:
                value = float(raw)
                if not 30 <= value <= 86400:
                    raise RuntimeError(f"ANALYZER_TIMEOUT_{name.upper()}_SECONDS must be between 30 and 86400")
                values[name] = value
        return cls(**values)

    def stage_seconds(self, phase: str, duration: float, profile: str):
        base = getattr(self, phase)
        # Long recordings get a larger finite budget; initialization is separate.
        factor = 2 if profile in {"max", "deep"} else 1
        extra = min(14400, max(0, duration - 600) * factor)
        return base + (extra if phase in {"media", "evidence", "model"} else 0)


def _build_processor(settings, client, monitor):
    from .__main__ import build_lazy_processor
    return build_lazy_processor(settings, client, monitor=monitor)


def _child_main(connection, settings, root, workspace, factory):
    # No model, FFmpeg, helper or task is started before the owner attaches us
    # to its Windows job object and sends the first command.
    try:
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
                def heartbeat(status, progress, stage):
                    with channel_lock:
                        connection.send(("heartbeat", (status, progress, stage)))
                        response, value = connection.recv()
                    if response != "ok":
                        raise RuntimeError("Analyzer owner rejected heartbeat")
                    return value
                try:
                    result = processor(job, heartbeat)
                    connection.send(("result", result))
                except Exception as error:  # process boundary: only safe, classified errors cross IPC
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

    def _start(self, job):
        context = multiprocessing.get_context("spawn")
        temporary_root = self.root / ".local" / "analyzer-work"
        temporary_root.mkdir(parents=True, exist_ok=True)
        self.workspace = Path(tempfile.mkdtemp(prefix="processor-", dir=temporary_root))
        (self.workspace / ".analyzer-owned").write_text("v1", encoding="ascii")
        self.connection, child = context.Pipe()
        self.tree = ProcessTree()
        self.process = context.Process(target=_child_main, args=(child, self.settings, str(self.root), str(self.workspace), self.factory))
        try:
            self.process.start()
            child.close()
            self.tree.attach(self.process.pid)
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
            if self.process.pid is not None:
                self.process.join(5)
            if self.process.pid is not None and self.process.is_alive():
                # Fail closed: do not start another task while the old process lives.
                raise SystemExit("Analyzer process could not be stopped; refusing to run another task")
            self.process.close()
            self.process = None
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

    def _send(self, value):
        try:
            self.connection.send(value)
        except (EOFError, OSError) as error:
            raise ProcessingFailure("ANALYZER_PROCESS_CRASHED", "分析处理进程通信中断，已释放资源，后续任务将继续。") from error

    def __call__(self, job, heartbeat):
        self.resources_released = False
        if self.process is None:
            self._start(job)
        started = phase_started = time.monotonic()
        phase = "initialization"
        duration = 0.0
        next_control = started
        try:
            self._send(("run", job))
            while True:
                now = time.monotonic()
                if now - started > self.limits.task + min(14400, duration * 2):
                    raise ProcessingFailure("ANALYZER_TASK_TIMEOUT", "分析超过本条任务的总时限，已回收处理进程；可从已有检查点重试。")
                if now - phase_started > self.limits.stage_seconds(phase, duration, job.analysis_profile):
                    raise ProcessingFailure("ANALYZER_STAGE_TIMEOUT", f"分析阶段 {phase} 超过处理时限，已回收处理进程；后续任务将继续。")
                if now >= next_control:
                    # Read-only control probe does not change the job version.
                    self.client.check_control(job)
                    next_control = time.monotonic() + self.limits.poll
                if self.connection.poll(min(0.2, self.limits.poll)):
                    try:
                        kind, value = self.connection.recv()
                    except (EOFError, OSError) as error:
                        raise ProcessingFailure("ANALYZER_PROCESS_CRASHED", "分析处理进程异常退出，已释放资源，后续任务将继续。") from error
                    if kind == "heartbeat":
                        status, progress, stage = value
                        new_phase = "initialization" if "初始化本地分析模型" in stage else {
                            "downloading": "download", "processing": "media", "transcribing": "evidence",
                            "extracting": "artifacts", "analyzing": "model",
                        }.get(status, phase)
                        if new_phase != phase:
                            phase, phase_started = new_phase, time.monotonic()
                        current = heartbeat(status, progress, stage)
                        self._send(("ok", current))
                    elif kind == "duration":
                        duration = max(0, min(86400, float(value)))
                    elif kind == "result":
                        self.resources_released = True
                        return value
                    elif kind == "failure":
                        raise ProcessingFailure(*value)
                elif not self.process.is_alive():
                    raise ProcessingFailure("ANALYZER_PROCESS_CRASHED", "分析处理进程异常退出，后续任务将继续；请检查内存和媒体依赖。")
        except BaseException:
            self.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()
