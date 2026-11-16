"""Bounded streaming contracts; no live source or model requests."""
import hashlib
from pathlib import Path

import httpx
import pytest

from liming_analyzer.douyin_collector.python import media, security
from liming_analyzer.douyin_collector.python.limits import MAX_MEDIA_BYTES
from liming_analyzer.douyin_collector.python.security import AppError

URL = 'https://public.contract.invalid/original.mp4'


class GeneratedStream(httpx.SyncByteStream):
    def __init__(self, generate):
        self.generate = generate

    def __iter__(self):
        yield from self.generate()


def transport(monkeypatch, generate, headers=None, status=200):
    monkeypatch.setattr(security, 'PublicTransport', lambda: httpx.MockTransport(
        lambda request: httpx.Response(status, headers=headers, stream=GeneratedStream(generate))))


def test_original_larger_than_old_cap_streams_to_disk_and_hashes_without_read_bytes(tmp_path, monkeypatch):
    block = b'x' * (1024 * 1024)
    count = 101
    expected = hashlib.sha256()
    for _ in range(count):
        expected.update(block)
    transport(monkeypatch, lambda: (block for _ in range(count)), {'Content-Length': str(len(block) * count)})
    monkeypatch.setattr(Path, 'read_bytes', lambda _path: pytest.fail('original must not be materialized in memory'))
    path = tmp_path / 'original.part'
    events = []
    result = security.download_public_to_file(URL, path, progress_callback=events.append)
    assert result['size_bytes'] == path.stat().st_size == 101 * 1024 * 1024
    assert result['sha256'] == expected.hexdigest() == security.sha256_file(path)
    assert events[-1]['downloaded_bytes'] == result['size_bytes']


def test_oversized_declared_original_is_rejected_before_body_and_leaves_no_file(tmp_path, monkeypatch):
    def forbidden():
        pytest.fail('declared oversize must be rejected before downloading body')
        yield b''
    transport(monkeypatch, forbidden, {'Content-Length': str(MAX_MEDIA_BYTES + 1)})
    path = tmp_path / 'original.part'
    with pytest.raises(AppError) as error:
        security.download_public_to_file(URL, path)
    assert error.value.code == 'too_large' and not path.exists()


def test_streamed_overflow_and_declared_short_read_remove_partial(tmp_path, monkeypatch):
    path = tmp_path / 'original.part'
    for headers, cap, expected in [({}, 3, 'too_large'), ({'Content-Length': '5'}, 10, 'douyin_incomplete')]:
        transport(monkeypatch, lambda: iter([b'ab', b'cd']), headers)
        with pytest.raises(AppError) as error:
            security.download_public_to_file(URL, path, cap)
        assert error.value.code == expected and not path.exists()


def test_file_download_allows_slow_progress_beyond_old_two_minute_budget_but_stops_at_fifteen(tmp_path, monkeypatch):
    now = [0.0]
    monkeypatch.setattr(security.time, 'monotonic', lambda: now[0])
    def generate():
        now[0] = 181.0
        yield b'complete'
    transport(monkeypatch, generate)
    path = tmp_path / 'original.part'
    assert security.download_public_to_file(URL, path)['size_bytes'] == 8
    path.unlink()
    now[0] = 0
    def late():
        now[0] = 901.0
        yield b'incomplete'
    transport(monkeypatch, late)
    with pytest.raises(AppError) as error:
        security.download_public_to_file(URL, path)
    assert error.value.code == 'source_timeout' and not path.exists()


def test_external_static_deadline_is_shared_not_reset_for_each_candidate(tmp_path, monkeypatch):
    now = [850.0]
    monkeypatch.setattr(security.time, 'monotonic', lambda: now[0])
    def generate():
        now[0] = 901.0
        yield b'too late for this static phase'
    transport(monkeypatch, generate)
    with pytest.raises(AppError) as error:
        security.download_public_to_file(URL, tmp_path / 'late.part', deadline=900.0)
    assert error.value.code == 'source_timeout' and not list(tmp_path.iterdir())


def test_cancelled_file_transfer_removes_owned_partial_without_overwriting_existing(tmp_path, monkeypatch):
    stopped = [False]
    def generate():
        stopped[0] = True
        yield b'cancelled'
    transport(monkeypatch, generate)
    path = tmp_path / 'original.part'
    with pytest.raises(AppError) as error:
        security.download_public_to_file(URL, path, cancelled=lambda: stopped[0])
    assert error.value.code == 'cancelled' and not path.exists()
    stopped[0] = False
    path.write_bytes(b'existing owned file')
    with pytest.raises(FileExistsError):
        security.download_public_to_file(URL, path)
    assert path.read_bytes() == b'existing owned file'


def test_file_redirects_keep_tls_identity_and_do_not_replay_cookies(tmp_path, monkeypatch):
    requests = []
    def respond(request):
        requests.append(request)
        assert 'cookie' not in request.headers
        assert request.headers['accept-encoding'] == 'identity'
        if request.url.path == '/original.mp4':
            return httpx.Response(302, headers={'Set-Cookie': 'synthetic=private; Path=/', 'Location': '/final.mp4'})
        return httpx.Response(200, content=b'original')
    monkeypatch.setattr(security, 'PublicTransport', lambda: httpx.MockTransport(respond))
    result = security.download_public_to_file(URL, tmp_path / 'original.part', headers={'Cookie': 'synthetic=private'})
    assert len(requests) == 2 and result['resolved_url'].endswith('/final.mp4')
    assert result['sha256'] == hashlib.sha256(b'original').hexdigest()


def test_file_redirect_cannot_downgrade_to_http(tmp_path, monkeypatch):
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(302, headers={'Location': 'http://127.0.0.1/private'})
    monkeypatch.setattr(security, 'PublicTransport', lambda: httpx.MockTransport(respond))
    with pytest.raises(AppError) as error:
        security.download_public_to_file(URL, tmp_path / 'original.part')
    assert error.value.code == 'unsafe_url' and len(requests) == 1
    assert not list(tmp_path.iterdir())


def test_streamed_length_mismatch_is_not_published(tmp_path, monkeypatch):
    transport(monkeypatch, lambda: iter([b'partial']), {'Content-Length': '9'})
    with pytest.raises(AppError) as error:
        security.download_public_to_file(URL, tmp_path / 'original.part')
    assert error.value.code == 'douyin_incomplete' and not list(tmp_path.iterdir())


def test_complete_response_requires_full_one_gib_range_and_keeps_new_cap():
    media._validate_complete_response({'Content-Range': f'bytes 0-{MAX_MEDIA_BYTES-1}/{MAX_MEDIA_BYTES}',
                                       'Content-Length': str(MAX_MEDIA_BYTES)}, MAX_MEDIA_BYTES)
    with pytest.raises(AppError):
        media._validate_complete_response({}, MAX_MEDIA_BYTES + 1)
    with pytest.raises(AppError):
        media._validate_complete_response({'Content-Range': f'bytes 0-999/{MAX_MEDIA_BYTES}'}, 1000)
