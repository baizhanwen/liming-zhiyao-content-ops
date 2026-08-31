from __future__ import annotations

import argparse
import sys
import threading

from .api_client import AnalyzerApiClient, AnalyzerApiError, ClaimedJob, Processor
from .bootstrap import AnalyzerSettings, build_client, build_pipeline
from .worker import process_once, run_forever


def build_lazy_processor(settings: AnalyzerSettings, client: AnalyzerApiClient) -> Processor:
    pipeline = None

    def process(job: ClaimedJob, heartbeat):
        nonlocal pipeline
        current_job = job
        if pipeline is None:
            warm_status = "analyzing" if job.checkpoint_stage in {"evidence_ready", "segment_progress"} else "downloading"
            warm_message = "正在初始化本地分析模型（首次使用可能需要下载）"
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
                pipeline = build_pipeline(settings, client)
            except Exception as error:
                raise RuntimeError(f"Analyzer model initialization failed: {error}") from error
            finally:
                stop_heartbeat.set()
                thread.join(timeout=6)
            if heartbeat_error:
                raise heartbeat_error[0]
        return pipeline.process(current_job, heartbeat)

    return process


def main() -> int:
    parser = argparse.ArgumentParser(description="Liming Zhiyao video analyzer worker")
    parser.add_argument("--once", action="store_true", help="claim at most one job")
    parser.add_argument("--idle-seconds", type=float, default=5.0)
    args = parser.parse_args()
    try:
        settings = AnalyzerSettings.from_environment()
        client = build_client(settings)
        processor = build_lazy_processor(settings, client)
        if args.once:
            return 0 if process_once(client, processor) else 2
        run_forever(client, processor, idle_seconds=max(0.5, args.idle_seconds))
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
