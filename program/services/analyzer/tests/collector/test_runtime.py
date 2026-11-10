"""Configured binaries follow each task, including actual broker executor hops.

All browser, network and subprocess peers are synthetic; no installed binary is run.
"""
import hashlib
import io
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier, Event, current_thread
from types import SimpleNamespace

import httpx
import pytest

from liming_analyzer.douyin_collector import CollectorError, collect
from liming_analyzer.douyin_collector.python import browser_capture as capture
from liming_analyzer.douyin_collector.python import media, runtime

VIDEO = "1234567890123456789"
PAGE = "https://www.douyin.com/video/" + VIDEO
DATA = b"explicit-synthetic-runtime-media"
PROBE = json.dumps({"format": {"duration": "3"}, "streams": [{"codec_type": "video"}]}).encode()


class MemoryPipe(io.StringIO):
    def close(self):
        pass


class SyntheticDriver:
    pid = 999999999

    def __init__(self):
        messages = [
            {"type": "fetch", "id": 1, "url": "https://synthetic.invalid/media"},
            {"type": "result", "ok": True, "page_url": PAGE,
             "observed_video_id": VIDEO, "observations": []},
        ]
        self.stdin = MemoryPipe()
        self.stdout = MemoryPipe("".join(json.dumps(message) + "\n" for message in messages))
        self.returncode = None

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self.returncode = 0
        return 0


class SyntheticGuard:
    """The explicit offline transport never makes sockets in this runtime test."""
    def __init__(self, *_args):
        self.server_address = ("127.0.0.1", 1)
        self.stopped = Event()

    def serve_forever(self):
        self.stopped.wait(timeout=5)

    def shutdown(self):
        self.stopped.set()

    def server_close(self):
        pass


@pytest.mark.parametrize("browser_worker", [False, True], ids=["main-media", "browser-executor"])
def test_collect_keeps_configured_binaries_isolated_across_concurrent_tasks(tmp_path, monkeypatch, browser_worker):
    calls = []
    start_together = Barrier(2)
    worker_together = Barrier(2)

    def run(command, **_kwargs):
        calls.append((command[0], Path(command[-1]), current_thread().name))
        return SimpleNamespace(stdout=PROBE)

    monkeypatch.setattr(media.subprocess, "run", run)

    def handle(broker, message):
        # This is dispatched by the production capture_douyin executor.submit.
        # Both tasks are alive here; plain executor.submit loses ContextVars.
        worker_together.wait(timeout=5)
        path = broker.folder / "worker-fixture.mp4"
        path.write_bytes(DATA)
        probe = capture._inspect_media(path)
        broker.synthetic_candidate = {"path": str(path), "probe": probe}
        return {"type": "reply", "id": message["id"], "abort": True}

    if browser_worker:
        monkeypatch.setattr(capture, "_Guard", SyntheticGuard)
        monkeypatch.setattr(capture.subprocess, "Popen", lambda *_args, **_kwargs: SyntheticDriver())
        monkeypatch.setattr(capture.shutil, "which", lambda _name: "synthetic-node")
        monkeypatch.setattr(capture, "_kill", lambda _process: None)
        monkeypatch.setattr(capture._Broker, "handle", handle)
        monkeypatch.setattr(capture._Broker, "finish", lambda broker, *_args: [broker.synthetic_candidate])

    def source(_url, folder, **_kwargs):
        start_together.wait(timeout=5)
        path = folder / "main-fixture.mp4"
        path.write_bytes(DATA)
        media.run_media(["ffmpeg", str(path)])
        media.inspect_video(path)
        if browser_worker:
            captured = capture.capture_douyin(
                PAGE, folder, video_id=VIDEO,
                transport_factory=lambda: httpx.MockTransport(lambda _request: pytest.fail("no HTTP expected")),
            )
            assert captured["media_files"][0]["probe"]["video"]
        return {"media_path": str(path), "video_id": VIDEO,
                "acquisition": {"media_sha256": hashlib.sha256(DATA).hexdigest()}}

    monkeypatch.setattr(media, "douyin_source", source)

    def task(label):
        result = collect(PAGE, tmp_path / label,
                         ffmpeg=f"/configured/{label}/ffmpeg",
                         ffprobe=f"/configured/{label}/ffprobe")
        assert Path(result["media_path"]).read_bytes() == DATA
        # Configuration ends with this task even when the thread is reused.
        assert runtime.media_executable("ffmpeg") == "ffmpeg"
        assert runtime.media_executable("ffprobe") == "ffprobe"

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(task, label) for label in ("first", "second")]
        for future in futures:
            future.result(timeout=10)

    for executable, media_path, _thread in calls:
        label = next(label for label in ("first", "second") if media_path.is_relative_to((tmp_path / label).resolve()))
        assert executable in {f"/configured/{label}/ffmpeg", f"/configured/{label}/ffprobe"}
    if browser_worker:
        worker_calls = [call for call in calls if call[2].startswith("capture-http")]
        assert len(worker_calls) == 2
        assert {call[0] for call in worker_calls} == {
            "/configured/first/ffprobe", "/configured/second/ffprobe",
        }


def test_collect_resets_configured_binaries_after_failure(tmp_path, monkeypatch):
    def fail(*_args, **_kwargs):
        assert runtime.media_executable("ffmpeg") == "/configured/failed/ffmpeg"
        raise CollectorError("douyin_fetch", "synthetic failure")

    monkeypatch.setattr(media, "douyin_source", fail)
    with pytest.raises(CollectorError):
        collect(PAGE, tmp_path, ffmpeg="/configured/failed/ffmpeg")
    assert runtime.media_executable("ffmpeg") == "ffmpeg"
    assert runtime.media_executable("ffprobe") == "ffprobe"
