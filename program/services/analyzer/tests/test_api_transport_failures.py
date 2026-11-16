"""Classify local API failures without replaying artifact or model work."""
import json
from unittest.mock import patch

import pytest

from liming_analyzer.api_client import AnalyzerApiClient, AnalyzerApiError, ClaimedJob
from liming_analyzer.worker import classify_worker_error


def job():
    return ClaimedJob("job", "org", "project", "video", "url", "processing", 22, 4, {}, attempt_count=2,
                      lease_expires_at="2030-01-01T00:00:00.000Z")


def test_claim_and_heartbeat_preserve_confirmed_lease_expiry():
    expiry = "2030-01-01T00:05:00.000Z"
    def transport(_method, url, _headers, _body):
        if url.endswith("claim"):
            data = {"job": {**job().__dict__, "lease_expires_at": expiry}}
        else:
            data = {"job": {"status": "processing", "progress": 22, "version": 5, "leaseExpiresAt": expiry}}
        return 200, json.dumps(data).encode()
    client = AnalyzerApiClient("http://localhost", "synthetic", "worker", transport)
    assert client.claim().lease_expires_at == expiry
    assert client.heartbeat(job(), "processing", 22, "saving").lease_expires_at == expiry


def test_control_transport_timeout_has_a_safe_specific_origin(caplog):
    def transport(*_args):
        raise TimeoutError("synthetic-secret-must-not-be-forwarded")
    client = AnalyzerApiClient("http://localhost", "synthetic", "worker", transport)
    with pytest.raises(AnalyzerApiError) as error:
        client.check_control(job())
    assert error.value.code == "CONTROL_CHECK_TIMEOUT"
    assert classify_worker_error(error.value)[0] == "CONTROL_CHECK_TIMEOUT"
    assert "operation=control" in caplog.text
    assert "synthetic-secret" not in caplog.text + str(error.value)


@pytest.mark.parametrize("attempt", [1, 3, True, "2", None])
def test_control_never_confirms_a_contradictory_execution_attempt(attempt):
    def transport(*_args):
        return 200, json.dumps({"version": 4, "attempt": attempt,
                                "leaseExpiresAt": "2030-01-01T00:05:00.000Z"}).encode()
    client = AnalyzerApiClient("http://localhost", "synthetic", "worker", transport)
    with pytest.raises(AnalyzerApiError) as error:
        client.check_control(job())
    assert error.value.status == 409 and error.value.code == "JOB_EXECUTION_REVOKED"


def test_unapplied_heartbeat_timeout_is_distinct_from_source_upload_failure():
    def transport(_method, url, _headers, _body):
        if url.endswith("heartbeat"):
            raise TimeoutError("timed out")
        return 200, json.dumps({"version": 4, "status": "processing", "progress": 22}).encode()
    client = AnalyzerApiClient("http://localhost", "synthetic", "worker", transport)
    with pytest.raises(AnalyzerApiError) as error:
        client.heartbeat(job(), "transcribing", 35, "speech")
    assert classify_worker_error(error.value)[0] == "ANALYZER_HEARTBEAT_UNAVAILABLE"


def test_lost_heartbeat_ack_reconciliation_keeps_renewed_expiry():
    def transport(_method, url, _headers, _body):
        if url.endswith("heartbeat"):
            raise TimeoutError("timed out")
        return 200, json.dumps({"version": 5, "status": "transcribing", "progress": 35,
                                "leaseExpiresAt": "2030-01-01T00:10:00.000Z"}).encode()
    client = AnalyzerApiClient("http://localhost", "synthetic", "worker", transport)
    updated = client.heartbeat(job(), "transcribing", 35, "speech")
    assert updated.version == 5 and updated.lease_expires_at == "2030-01-01T00:10:00.000Z"


def test_source_upload_timeout_is_not_automatically_replayed(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"synthetic")
    calls = []
    def transport(*args):
        calls.append(args)
        raise TimeoutError("timed out")
    client = AnalyzerApiClient("http://localhost", "synthetic", "worker", transport)
    with pytest.raises(AnalyzerApiError) as error:
        client.upload_artifact(job(), kind="source_video", path=source, content_type="video/mp4")
    assert len(calls) == 1
    assert classify_worker_error(error.value)[0] == "SOURCE_PERSISTENCE_FAILED"


@pytest.mark.parametrize("kind,expected", [("source_video", 120), ("keyframe", 30)])
def test_blob_upload_has_its_own_idle_timeout_and_small_artifacts_keep_default(tmp_path, kind, expected):
    source = tmp_path / "artifact"
    source.write_bytes(b"synthetic")
    class Response:
        status = 201
        def __enter__(self): return self
        def __exit__(self, *_args): return False
        def read(self): return b'{"asset":{"id":"saved"}}'
    def opener(request, timeout):
        assert timeout == expected
        if kind == "source_video":
            assert request.data.read() == b"synthetic"
        return Response()
    client = AnalyzerApiClient("http://localhost", "synthetic", "worker")
    with patch("liming_analyzer.api_client.urllib.request.urlopen", side_effect=opener):
        client.upload_artifact(job(), kind=kind, path=source,
                               content_type="video/mp4" if kind == "source_video" else "image/jpeg")
