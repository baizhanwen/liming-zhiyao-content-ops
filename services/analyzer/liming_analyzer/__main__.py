from __future__ import annotations

import argparse

from .bootstrap import AnalyzerSettings, build_analyzer
from .worker import process_once, run_forever


def main() -> int:
    parser = argparse.ArgumentParser(description="Liming Zhiyao video analyzer worker")
    parser.add_argument("--once", action="store_true", help="claim at most one job")
    parser.add_argument("--idle-seconds", type=float, default=5.0)
    args = parser.parse_args()
    client, pipeline = build_analyzer(AnalyzerSettings.from_environment())
    if args.once:
        return 0 if process_once(client, pipeline.process) else 2
    run_forever(client, pipeline.process, idle_seconds=max(0.5, args.idle_seconds))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
