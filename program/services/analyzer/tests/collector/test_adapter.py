"""Standalone adapter boundaries; all media bytes here are synthetic fixtures."""
from pathlib import Path
from threading import Event
import hashlib
import json

import httpx
import pytest

from liming_analyzer.douyin_collector import collect, CollectorError
from liming_analyzer.douyin_collector import adapter
from liming_analyzer.douyin_collector.python import media, security

PAGE = 'https://www.douyin.com/video/1234567890123456789'


@pytest.mark.parametrize('text', ['没有链接', PAGE+' https://v.douyin.com/another/'])
def test_single_reference_is_required_before_any_network(text, tmp_path, monkeypatch):
    monkeypatch.setattr(media, 'douyin_source', lambda *a, **k: pytest.fail('network forbidden'))
    with pytest.raises(CollectorError) as err:
        collect(text, tmp_path)
    assert err.value.code == 'single_reference_required'


def test_cancelled_input_never_creates_media(tmp_path):
    stop = Event(); stop.set()
    with pytest.raises(CollectorError) as err:
        collect(PAGE, tmp_path/'job', cancelled=stop)
    assert err.value.code == 'cancelled'
    assert not (tmp_path/'job').exists()


def test_success_is_atomic_and_transient_headers_never_leave_adapter(tmp_path, monkeypatch):
    data = b'explicit-self-authored-media-fixture'
    digest = hashlib.sha256(data).hexdigest()
    def source(url, folder, **kwargs):
        path = folder/'douyin.mp4'; path.write_bytes(data)
        (folder/'private-response-cache').write_text('visitor=private; signed-url=private')
        return {'media_path':str(path),'video_id':'1234567890123456789','title':'fixture',
                'acquisition':{'media_sha256':digest,'method':'synthetic_fixture','cookie':'private'}}
    monkeypatch.setattr(media, 'douyin_source', source)
    monkeypatch.setattr(media, 'inspect_video', lambda p:{'video':True,'audio':False,'duration':3.0})
    result = collect(PAGE,tmp_path)
    assert Path(result['media_path']).read_bytes() == data
    assert result['sha256'] == digest and result['coverage'] == [[0,len(data)]]
    assert len(list(tmp_path.iterdir())) == 1
    assert 'cookie' not in json.dumps(result) and 'signed-url=private' not in json.dumps(result)


def test_cancel_after_response_cleans_all_files(tmp_path, monkeypatch):
    stop = Event()
    def source(url, folder, **kwargs):
        (folder/'partial').write_bytes(b'partial'); stop.set()
        return {}
    monkeypatch.setattr(media,'douyin_source',source)
    with pytest.raises(CollectorError) as err:
        collect(PAGE,tmp_path,cancelled=stop)
    assert err.value.code == 'cancelled' and not list(tmp_path.iterdir())


def test_symlink_ancestor_rejected(tmp_path):
    real=tmp_path/'real'; real.mkdir()
    link=tmp_path/'link';link.symlink_to(real,target_is_directory=True)
    with pytest.raises(CollectorError) as err:
        collect(PAGE,link/'job')
    assert err.value.code == 'unsafe_storage'


@pytest.mark.parametrize('headers,size', [
    ({'content-range':'bytes 0-3/8'},4),
    ({'content-range':'bytes 4-7/8'},4),
    ({'content-length':'9'},8),
    ({'x-collector-http-status':'206'},8),
    ({'content-range':'bytes */8'},8),
])
def test_static_partial_responses_are_rejected(headers,size):
    with pytest.raises(CollectorError) as err:
        media._validate_complete_response(headers,size)
    assert err.value.code == 'douyin_incomplete'


def test_static_full_range_is_valid():
    media._validate_complete_response({'Content-Range':'bytes 0-7/8','Content-Length':'8'},8)


@pytest.mark.parametrize('target', [
    'http://www.douyin.com/video/123',
    'https://outside.invalid/video/123',
    'https://www.douyin.com/video/9876543210123456789',
])
def test_static_redirect_chain_stays_https_official_and_one_identity(target,monkeypatch):
    calls=[]
    def respond(request):
        calls.append(str(request.url))
        return httpx.Response(302, headers={'Location':target})
    monkeypatch.setattr(security,'PublicTransport',lambda:httpx.MockTransport(respond))
    with pytest.raises(CollectorError):
        security.fetch_public(PAGE,official_only=True)
    assert calls == [PAGE]


def test_browser_diagnostics_are_sanitized_at_adapter_boundary(tmp_path,monkeypatch):
    def source(*a,**k):
        err=CollectorError('restricted','匿名采集受限')
        err.capture_diagnostic={'requests':3,'signed_url':'private','renderer_progress':{'cookie':'private'}}
        raise err
    monkeypatch.setattr(media,'douyin_source',source)
    with pytest.raises(CollectorError) as caught:
        collect(PAGE,tmp_path)
    assert not hasattr(caught.value,'capture_diagnostic')
    assert caught.value.diagnostics == {'requests':3}
