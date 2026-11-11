from __future__ import annotations

import argparse
import logging
import sys
import threading
from dataclasses import replace

from .api_client import AnalyzerApiClient, AnalyzerApiError, ClaimedJob, Processor
from .bootstrap import AnalyzerSettings, build_client, build_pipeline
from .worker import process_once, run_forever
from .platform_runtime import InstanceAlreadyRunning
from .task_progress import observe


def build_lazy_processor(settings: AnalyzerSettings, client: AnalyzerApiClient, monitor=None) -> Processor:
    pipeline = None
    pipeline_settings = None

    def process(job: ClaimedJob, heartbeat):
        nonlocal pipeline, pipeline_settings
        current_job = job
        fetch_configuration = getattr(client, "model_configuration", None)
        transcript_only = job.source.get("transcript_only") is True
        active_settings = settings
        if not transcript_only and callable(fetch_configuration):
            active_settings = replace(settings, **fetch_configuration(job))
        pipeline_key = (active_settings, transcript_only)
        if pipeline is None or pipeline_settings != pipeline_key:
            warm_status = "analyzing" if job.checkpoint_stage in {"evidence_ready", "segment_progress"} else "downloading"
            warm_message = "正在初始化本地分析模型（首次使用可能需要下载）"
            observe(heartbeat, "loading_models")
            current_job = heartbeat(warm_status, max(2, job.progress), warm_message)
            stop_heartbeat = threading.Event()
            heartbeat_error: list[Exception] = []

            def keep_warmup_alive() -> None:
                nonlocal current_job
                while not stop_heartbeat.wait(5):
                    try:
                        current_job = heartbeat(
                            warm_status,
                            max(2, current_job.progress),
                            warm_message,
                        )
                    except Exception as error:  # noqa: BLE001 - propagate after warmup
                        heartbeat_error.append(error)
                        stop_heartbeat.set()

            thread = threading.Thread(
                target=keep_warmup_alive,
                name="analyzer-model-warmup-heartbeat",
                daemon=True,
            )
            thread.start()
            try:
                pipeline = (build_pipeline(active_settings, client, transcript_only=True)
                            if transcript_only else build_pipeline(active_settings, client))
                pipeline_settings = pipeline_key
                if monitor is not None:
                    pipeline.runtime_monitor = monitor
            except Exception as error:
                raise RuntimeError(f"Analyzer model initialization failed: {error}") from error
            finally:
                stop_heartbeat.set()
                thread.join(timeout=6)
            if heartbeat_error:
                raise heartbeat_error[0]
        return pipeline.process(current_job, heartbeat)

    return process


def configure_worker_logging() -> None:
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logging.getLogger("liming_analyzer").setLevel(logging.INFO)


def main() -> int:
    configure_worker_logging()
    logging.getLogger(__name__).info("Analyzer entrypoint: %s", __file__)
    parser = argparse.ArgumentParser(description="Liming Zhiyao video analyzer worker")
    parser.add_argument("--once", action="store_true", help="claim at most one job")
    parser.add_argument("--idle-seconds", type=float, default=5.0)
    args = parser.parse_args()
    try:
        settings = AnalyzerSettings.from_environment()
        from .process_runtime import IsolatedProcessor
        from .platform_runtime import InstanceLock, installation_root, watch_supervisor
        watch_supervisor()
        with InstanceLock(installation_root()):
            client = build_client(settings)
            with IsolatedProcessor(settings, client) as processor:
                if args.once:
                    return 0 if process_once(client, processor) else 2
                run_forever(client, processor, idle_seconds=max(0.5, args.idle_seconds))
        return 0
    except InstanceAlreadyRunning:
        print("This installation already has an active analyzer; no second worker was started.")
        return 0
    except AnalyzerApiError as error:
        if error.status in {401, 403}:
            print(
                "Analyzer authentication failed. ANALYZER_SERVICE_TOKEN must match the web "
                "application configuration.",
                file=sys.stderr,
            )
            return 21
        print(f"Analyzer API stopped the worker: {error}", file=sys.stderr)
        return 22
    except RuntimeError as error:
        if str(error).startswith("missing analyzer settings:"):
            print(str(error), file=sys.stderr)
            return 20
        raise


if __name__ == "__main__":
    raise SystemExit(main())
