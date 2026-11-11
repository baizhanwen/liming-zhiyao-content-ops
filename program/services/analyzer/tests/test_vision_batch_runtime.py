"""Bounded scheduling and truthful accounting, without any network/model calls."""
import asyncio
import json
import time
from collections import Counter
from contextlib import asynccontextmanager
from threading import Lock
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from PIL import Image

from liming_analyzer.adapters import Keyframe
from liming_analyzer.minimax_vision import (
    McpVisionCallResult,
    MiniMaxTokenPlanMcpRunner,
    _run_bounded_calls,
)
from liming_analyzer.visual import OpenAiCompatibleVisionEngine


def frames_at(tmp_path, count, *, temporal=False):
    image = tmp_path / "frame.jpg"
    Image.new("RGB", (16, 16), "white").save(image)
    return [Keyframe(index * 125, image, roles=(f"temporal:g{index // 3}",) if temporal else ()) for index in range(count)]


def frame_manifest(kwargs):
    text = kwargs["messages"][1]["content"][0]["text"]
    return json.loads(text.split("frame_manifest=", 1)[1])


def completion(manifest, *, usage=True, malformed=False):
    payload = {"observations": [{"frame_index": row["frame_index"], "composition": "主体居中", "confidence": 90} for row in manifest]}
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content="invalid JSON" if malformed else json.dumps(payload)))],
        usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5, total_tokens=15,
                              completion_tokens_details=SimpleNamespace(reasoning_tokens=2)) if usage else None,
    )


def engine_for(create, **kwargs):
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    return OpenAiCompatibleVisionEngine(api_key="", base_url="https://fixture.invalid", model="fixture", provider="fixture", client=client, **kwargs)


def test_two_concurrent_batches_keep_temporal_groups_progress_and_independent_receipts(tmp_path):
    active = maximum = 0
    lock = Lock()
    manifests, requests, receipts, progress = [], [], [], []

    def create(**kwargs):
        nonlocal active, maximum
        manifest = frame_manifest(kwargs)
        with lock:
            active += 1
            maximum = max(maximum, active)
            manifests.append(manifest)
            requests.append(kwargs)
        time.sleep(.02)
        with lock:
            active -= 1
        return completion(manifest)

    engine = engine_for(create, batch_size=3)
    engine.set_call_context(SimpleNamespace(id="fixture"), lambda _job, row: receipts.append(row))
    engine.set_progress_callback(progress.append)
    result = engine.analyze(frames_at(tmp_path, 12, temporal=True))

    assert maximum == 2
    assert [row.start_ms for row in result] == [index * 125 for index in range(12)]
    assert all(len({row["roles"][0] for row in manifest}) == 1 and len(manifest) == 3 for manifest in manifests)
    assert all(row["max_tokens"] == 4800 for row in requests)
    assert engine.last_stats["total_input_tokens"] == 40
    assert engine.last_stats["total_output_tokens"] == 20
    assert engine.last_stats["total_tokens"] == 60
    assert all(row["elapsed_ms"] >= 10 and row["reasoning_tokens"] == 2 and row["failure_kind"] is None for row in engine.last_stats["batches"])
    assert len({row["id"] for row in receipts}) == 4
    assert Counter(row["status"] for row in receipts) == {"started": 4, "completed": 4}
    assert all(row["task"] == "vision_batch" and row["outputBudget"] == 4800 for row in receipts)
    assert [row["batch_completed"] for row in progress] == list(range(5))


class Overloaded(RuntimeError):
    status_code = 529


def test_overload_shrinks_admission_and_allows_only_one_shared_retry(tmp_path):
    active = 0
    starts, counts = [], Counter()
    lock = Lock()

    def create(**kwargs):
        nonlocal active
        manifest = frame_manifest(kwargs)
        stamp = manifest[0]["timestamp_ms"]
        with lock:
            active += 1
            counts[stamp] += 1
            attempt = counts[stamp]
            starts.append((stamp, active))
        time.sleep(.01 if stamp == 0 else .03)
        with lock:
            active -= 1
        if stamp == 0 and attempt == 1:
            raise Overloaded("synthetic overload")
        return completion(manifest)

    engine = engine_for(create, batch_size=1, overload_backoff_seconds=0)
    result = engine.analyze(frames_at(tmp_path, 5))
    assert len(result) == 5
    assert counts[0] == 2 and sum(counts.values()) == 6
    assert all(active_count == 1 for _, active_count in starts[2:])
    assert engine.last_stats["status"] == "completed"
    assert engine.last_stats["effective_concurrency"] == 1
    assert engine.last_stats["overload_retry_count"] == 1
    assert engine.last_stats["request_count"] == 6
    # Unknown failed-call usage cannot be replaced with zero, even after recovery.
    assert engine.last_stats["total_tokens"] is None
    assert engine.last_stats["batches"][0]["failure_kind"] == "overloaded"


@pytest.mark.parametrize("error", [Overloaded("busy"), TimeoutError("timeout")])
def test_repeated_overload_is_bounded_and_timeout_is_not_retried(tmp_path, error):
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        raise error

    engine = engine_for(create, batch_size=1, overload_backoff_seconds=0)
    assert engine.analyze(frames_at(tmp_path, 4)) == []
    assert len(calls) == (5 if isinstance(error, Overloaded) else 4)
    assert engine.last_stats["failed_batches"] == 4
    assert engine.last_stats["total_tokens"] is None
    assert all(row["input_tokens"] is None for row in engine.last_stats["batches"])


@pytest.mark.parametrize("malformed", [False, True])
def test_invalid_json_keeps_known_charge_and_incomplete_frames_are_not_success(tmp_path, malformed):
    receipts = []

    def create(**kwargs):
        return completion(frame_manifest(kwargs)[:1], malformed=malformed)

    engine = engine_for(create, batch_size=3)
    engine.set_call_context(SimpleNamespace(id="fixture"), lambda _job, row: receipts.append(row))
    result = engine.analyze(frames_at(tmp_path, 3))
    assert len(result) == (0 if malformed else 1)
    assert len(receipts) == 2 and receipts[-1]["status"] == "completed"
    assert receipts[-1]["totalTokens"] == 15
    assert engine.last_stats["status"] == "failed"
    assert engine.last_stats["total_tokens"] == 15
    assert engine.last_stats["batches"][0]["failure_kind"] == ("invalid_response" if malformed else "incomplete_response")


def test_mcp_tool_calls_record_unknown_cap_and_usage_without_blocking_async_loop():
    receipts = []
    runner = MiniMaxTokenPlanMcpRunner(api_key="fixture-key", api_host="https://api.minimax.io")
    runner.set_call_context(SimpleNamespace(id="fixture"), lambda _job, row: receipts.append(row))

    async def run():
        async def success():
            await asyncio.sleep(.01)
            return McpVisionCallResult("{}")

        async def failure():
            await asyncio.sleep(.01)
            return McpVisionCallResult("HTTP 529", is_error=True, message="HTTP 529", usage={"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3})

        return await asyncio.gather(runner._recorded_call(success), runner._recorded_call(failure))

    results = asyncio.run(run())
    assert all(result.elapsed_ms >= 5 and result.started_at and result.completed_at for result in results)
    assert len({row["id"] for row in receipts}) == 2
    assert all(row["outputBudget"] == 0 and row["task"] == "vision_batch" for row in receipts)
    completed = next(row for row in receipts if row["status"] == "completed")
    failed = next(row for row in receipts if row["status"] == "failed")
    assert completed.get("totalTokens") is None
    assert failed["totalTokens"] == 3
    assert results[0].usage is None


def test_mcp_overload_reduces_queued_work_to_one_without_retry():
    active = 0
    starts = []

    async def run():
        async def operation(request):
            nonlocal active
            active += 1
            starts.append((request["id"], active))
            await asyncio.sleep(.01 if request["id"] == "0" else .03)
            active -= 1
            return McpVisionCallResult(request["id"], is_error=request["id"] == "0", message="HTTP 529" if request["id"] == "0" else None)

        return await _run_bounded_calls([{"id": str(index)} for index in range(4)], concurrency=3, operation=operation)

    result = asyncio.run(run())
    assert [row.text for row in result] == [str(index) for index in range(4)]
    assert starts[:2] == [("0", 1), ("1", 2)]
    assert starts[2:] == [("2", 1), ("3", 1)]


def test_real_mcp_runner_tool_boundary_forwards_each_request_and_usage():
    calls, receipts = [], []

    class Session:
        def __init__(self, *_args):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            pass

        async def initialize(self):
            return SimpleNamespace(serverInfo=SimpleNamespace(name="fixture", version="1"))

        async def list_tools(self):
            return SimpleNamespace(tools=[SimpleNamespace(name="understand_image")])

        async def call_tool(self, name, arguments, **kwargs):
            calls.append((name, arguments, kwargs))
            return SimpleNamespace(content=[SimpleNamespace(text="{}", type="text")], isError=False,
                                   usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})

    @asynccontextmanager
    async def stdio_client(*_args, **_kwargs):
        yield None, None

    modules = {"mcp": SimpleNamespace(ClientSession=Session, StdioServerParameters=SimpleNamespace),
               "mcp.client": SimpleNamespace(), "mcp.client.stdio": SimpleNamespace(stdio_client=stdio_client)}
    runner = MiniMaxTokenPlanMcpRunner(api_key="fixture-key", api_host="https://api.minimax.io")
    runner.set_call_context(SimpleNamespace(id="fixture"), lambda _job, row: receipts.append(row))
    requests = [{"prompt": "first", "image_source": "first.jpg"}, {"prompt": "second", "image_source": "second.jpg"}]
    with patch.dict("sys.modules", modules):
        results, metadata = runner.call_many(requests)
    # Thread admission is bounded, while the two actual tool starts may swap.
    assert sorted((row[1] for row in calls), key=lambda row: row["prompt"]) == requests
    assert all(row[0] == "understand_image" for row in calls)
    assert all(not row.is_error and row.usage["total_tokens"] == 15 for row in results)
    assert metadata["tool_connected"] and metadata["effective_concurrency"] == 2
    assert sum(row.get("totalTokens", 0) or 0 for row in receipts) == 30
