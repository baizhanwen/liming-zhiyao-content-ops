"""Long-media limits with bounded synthetic streams; no external site/model use."""
import hashlib
import json
import shutil
import subprocess
import time
import tracemalloc
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

import liming_analyzer.douyin_collector.python.browser_capture as capture
from liming_analyzer.douyin_collector.python.security import AppError

VIDEO = '1234567890123456789'
PAGE = 'https://www.douyin.com/video/' + VIDEO
TARGET = 'https://cdn.contract.invalid/long.mp4?signature=synthetic-only'


def broker(folder, respond):
    return capture._Broker(folder, VIDEO, time.monotonic() + 30,
        transport_factory=lambda: httpx.MockTransport(respond),
        media_inspector=lambda _path: {'video': True, 'audio': True, 'duration': 1800})


class RepeatedBytes(httpx.SyncByteStream):
    def __init__(self, total, chunk):
        self.total, self.chunk = total, chunk

    def __iter__(self):
        remaining = self.total
        while remaining:
            amount = min(len(self.chunk), remaining)
            yield self.chunk[:amount]
            remaining -= amount


def test_over_old_100_mib_response_streams_to_disk_without_whole_file_reads(tmp_path, monkeypatch):
    total = 101 * 1024 * 1024 + 13
    chunk = b'0000ftyp' + b'x' * (1024 * 1024 - 8)
    service = broker(tmp_path, lambda _request: httpx.Response(200,
        headers={'Content-Type': 'video/mp4', 'Content-Length': str(total)},
        stream=RepeatedBytes(total, chunk)))
    service.urls.add(TARGET)
    monkeypatch.setattr(Path, 'read_bytes', lambda _path: pytest.fail('Media must use bounded file reads'))
    expected = hashlib.sha256()
    for piece in RepeatedBytes(total, chunk):
        expected.update(piece)
    tracemalloc.start()
    try:
        reply = service.handle({'id': 1, 'url': TARGET, 'method': 'GET', 'headers': {}, 'resource_type': 'media'})
        assert reply['capture_ready']
        result = service.finish([], VIDEO)[0]
        assert result['size'] == total and result['coverage'] == [[0, total]]
        assert result['sha256'] == expected.hexdigest()
        assert Path(result['path']).stat().st_size == total
        assert tracemalloc.get_traced_memory()[1] < 16 * 1024 * 1024
        assert not list(tmp_path.glob('response-*'))
    finally:
        tracemalloc.stop()
        service.close()


def test_exact_gib_sparse_file_is_accepted_and_one_byte_over_is_rejected(tmp_path):
    service = broker(tmp_path, lambda _request: pytest.fail('No network needed'))
    try:
        assert service.max_bytes == 1024 ** 3
        source = tmp_path / 'synthetic-response'
        with source.open('wb') as stream:
            stream.truncate(service.max_bytes)
        result = service._record_file(TARGET, {}, 200, {}, source, service.max_bytes, 'video/mp4')
        assert result.stat().st_size == service.max_bytes
        over = tmp_path / 'over'
        over.write_bytes(b'x')
        with pytest.raises(AppError) as error:
            service._record_file(TARGET + '&over=1', {}, 206,
                {'content-range': f'bytes 0-0/{service.max_bytes + 1}'}, over, 1, 'video/mp4')
        assert error.value.code == 'douyin_browser_budget'
    finally:
        service.close()


def test_truncated_stream_is_not_recorded_and_its_partial_file_is_removed(tmp_path):
    service = broker(tmp_path, lambda _request: httpx.Response(200,
        headers={'Content-Type': 'video/mp4', 'Content-Length': '200'},
        stream=RepeatedBytes(100, b'x' * 10)))
    service.urls.add(TARGET)
    try:
        reply = service.handle({'id': 1, 'url': TARGET, 'method': 'GET', 'headers': {}, 'resource_type': 'media'})
        assert reply['abort'] and not service.entries
        assert service.errors == {'douyin_browser_range': 1}
        assert not list(tmp_path.iterdir())
    finally:
        service.close()


def test_cancellation_during_a_large_stream_removes_partial_media(tmp_path):
    service = broker(tmp_path, lambda _request: httpx.Response(200,
        headers={'Content-Type': 'video/mp4'},
        stream=RepeatedBytes(20 * 1024 * 1024, b'x' * 1024 * 1024)))
    checks = []
    def cancelled():
        checks.append(True)
        return len(checks) > 4
    service.cancelled = cancelled
    service.urls.add(TARGET)
    try:
        reply = service.handle({'id': 1, 'url': TARGET, 'method': 'GET', 'headers': {}, 'resource_type': 'media'})
        assert reply['abort'] and not service.entries
        assert service.errors == {'cancelled': 1}
        assert not list(tmp_path.iterdir())
    finally:
        service.close()


def test_more_than_sixteen_ranges_complete_and_supplements_do_not_accumulate_response_files(tmp_path):
    chunk, total, requests = b'x' * (1024 * 1024), 20 * 1024 * 1024, []
    def respond(request):
        value = request.headers.get('range')
        start = int(value.split('=')[1].split('-')[0]) if value else 0
        end = min(start + len(chunk), total) - 1
        requests.append((start, end))
        return httpx.Response(206, content=chunk[:end - start + 1],
            headers={'Content-Type': 'video/mp4', 'Content-Range': f'bytes {start}-{end}/{total}'})
    service = broker(tmp_path, respond)
    service.urls.add(TARGET)
    try:
        reply = service.handle({'id': 1, 'url': TARGET, 'method': 'GET', 'headers': {}, 'resource_type': 'media'})
        assert reply['capture_ready']
        assert len(requests) > 16
        assert service.complete()[0]['ranges'] == [(0, total)]
        assert len(list(tmp_path.glob('response-*'))) == 1, 'Only the renderer-owned initial response is retained'
    finally:
        service.close()


def test_stalled_ranges_stop_without_consuming_the_larger_request_budget(tmp_path):
    requests = []
    def respond(request):
        requests.append(request.headers.get('range'))
        return httpx.Response(206, content=b'xxxx',
            headers={'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-3/32'})
    service = broker(tmp_path, respond)
    service.urls.add(TARGET)
    try:
        reply = service.handle({'id': 1, 'url': TARGET, 'method': 'GET', 'headers': {}, 'resource_type': 'media'})
        assert not reply['capture_ready'] and not service.complete()
        assert len(requests) == 3
    finally:
        service.close()


@pytest.mark.parametrize('field,value,seconds', [
    ('duration', 2000, 2), ('duration', 1800000, 1800), ('duration', 3600000, 3600),
    ('duration_ms', 2000, 2), ('duration_seconds', 1800, 1800), ('duration_seconds', 3600, 3600),
])
def test_official_metadata_units_are_independent_of_the_duration_limit(tmp_path, field, value, seconds):
    service = broker(tmp_path, lambda _request: httpx.Response(404))
    try:
        service._bind_json(json.dumps({'aweme_id': VIDEO, 'video': {field: value}}).encode(), PAGE)
        assert service.metadata_durations == {seconds}
    finally:
        service.close()


@pytest.mark.parametrize('values,expected', [
    ({'duration_seconds': 1800, 'duration_ms': 1800000, 'duration': 1800000}, {1800}),
    ({'duration_seconds': 1800, 'duration_ms': 3600000}, set()),
    ({'duration_seconds': None, 'duration_ms': 1800000}, set()),
    ({'duration_seconds': True, 'duration_ms': 1800000}, set()),
    ({'duration_seconds': 3601, 'duration_ms': 3601000}, set()),
])
def test_conflicting_or_invalid_explicit_units_do_not_attest_duration(tmp_path, values, expected):
    service = broker(tmp_path, lambda _request: httpx.Response(404))
    try:
        service._bind_json(json.dumps({'aweme_id': VIDEO, 'video': values}).encode(), PAGE)
        assert service.metadata_durations == expected
    finally:
        service.close()


@pytest.mark.parametrize('seconds,accepted', [(1201, True), (1800, True), (3600, True), (3600.01, False)])
def test_actual_media_probe_accepts_one_hour_and_rejects_above(tmp_path, monkeypatch, seconds, accepted):
    result = {'format': {'duration': seconds}, 'streams': [{'codec_type': 'video'}]}
    monkeypatch.setattr(capture.subprocess, 'run', lambda *_args, **_kwargs: SimpleNamespace(stdout=json.dumps(result)))
    if accepted:
        assert capture._inspect_media(tmp_path / 'fixture')['duration'] == seconds
    else:
        with pytest.raises(AppError):
            capture._inspect_media(tmp_path / 'fixture')


def test_node_ipc_and_cdp_limits_accept_new_bounds_and_still_reject_excess():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node required for production driver fragment test')
    script = r"""import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const source=fs.readFileSync('node/capture-douyin.mjs','utf8');
const start=source.indexOf('  const options = await start;'), end=source.indexOf('  const target =',start);
const prefix=source.slice(source.indexOf('const MAX_MEDIA_BYTES'),source.indexOf('const start = new Promise'));
const handlers={};let closed=0;
const context=vm.createContext({start:Promise.resolve({timeout_ms:1800000,max_bytes:2*1024**3,max_total_bytes:8*1024**3,max_requests:9999}),
  network:{on:(key,callback)=>handlers[key]=callback},page:{close:()=>{closed++;return Promise.resolve();}},Map});
const limits=await vm.runInContext('(async()=>{'+prefix+source.slice(start,end)+'return{options,mediaByteLimit,totalByteLimit,requestLimit};})()',context);
assert.equal(limits.options.timeout_ms,900000);assert.equal(limits.mediaByteLimit,1024**3);assert.equal(limits.totalByteLimit,4*1024**3);assert.equal(limits.requestLimit,1536);
context.mediaByteLimit=limits.mediaByteLimit;context.totalByteLimit=limits.totalByteLimit;context.budgetExceeded=false;
const networkStart=source.indexOf('  const resourceBytes = new Map();'),networkEnd=source.indexOf('  let pageErrors =',networkStart);
vm.runInContext(source.slice(networkStart,networkEnd),context);
handlers['Network.responseReceived']({requestId:'long',type:'Media',response:{mimeType:'video/mp4'}});
handlers['Network.dataReceived']({requestId:'long',dataLength:1024**3});assert.equal(closed,0);
handlers['Network.dataReceived']({requestId:'long',dataLength:1});assert.equal(closed,1);
console.log('PASS: IPC clamps and media resource boundary');"""
    result = subprocess.run([node, '--input-type=module', '-e', script], cwd=capture.PROJECT,
        capture_output=True, text=True, timeout=5)
    assert result.returncode == 0, result.stderr
