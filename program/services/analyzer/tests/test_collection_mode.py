"""Explicit per-organization Cookie acquisition; all credentials/media synthetic."""
from dataclasses import replace
import io
from pathlib import Path
import urllib.error
from unittest.mock import patch

import pytest

from liming_analyzer.adapters import AcquiredSource
from liming_analyzer.api_client import AnalyzerApiClient, AnalyzerApiError, ClaimedJob
from liming_analyzer.source_errors import SourceDownloadError
from liming_analyzer.sources import PlatformSourceProvider, YtDlpPublicVideoResolver

URL = "https://www.douyin.com/video/1234567890123456789"


def job(mode=None, org="first", source_type="url"):
    source = {"source_url": URL}
    if mode is not None:
        source["collection_mode"] = mode
    return ClaimedJob("job-" + org, org, "project", "video", source_type, "queued", 1, 1, source, attempt_count=1)


class Anonymous:
    uses_cookie_snapshots = False
    def __init__(self):
        self.callbacks = []
        self.calls = 0
    def set_progress(self, callback):
        self.callbacks.append(callback)
    def download(self, _url, destination):
        self.calls += 1
        destination.write_bytes(b"anonymous original")
        return AcquiredSource(destination)


class Client:
    def __init__(self, snapshots=None):
        self.snapshots = snapshots or {}
        self.requests = []
    def download_cookie_snapshot(self, current, destination):
        self.requests.append(current.organization_id)
        if current.organization_id not in self.snapshots:
            return False
        destination.write_text(self.snapshots[current.organization_id])
        return True
    def download_upload_source(self, _job, destination):
        destination.write_bytes(b"uploaded original")
        return destination


def downloader(action):
    class Downloader:
        def __init__(self, options):
            self.options = options
        def __enter__(self):
            return self
        def __exit__(self, *_args):
            return False
        def extract_info(self, _url, download=True):
            assert download
            override = action(self.options)
            if isinstance(override, dict):
                return override
            output = Path(self.options["outtmpl"].replace("%(ext)s", "mp4"))
            output.write_bytes(b"cookie original")
            return {"id": "1234567890123456789", "duration": 12, "filepath": str(output)}
    return Downloader


def strict_resolver(action=lambda _options: None, **options):
    return YtDlpPublicVideoResolver(downloader(action), organization_cookie_only=True,
        media_inspector=lambda _path: {"video": True, "audio": True, "duration": 12}, **options)


def test_default_and_explicit_anonymous_never_fetch_snapshots_or_initialize_cookie_resolver(tmp_path):
    client, anonymous = Client({"first": "private synthetic Cookie"}), Anonymous()
    def forbidden():
        raise AssertionError("Cookie dependency must not initialize")
    provider = PlatformSourceProvider(client, anonymous, cookie_video_factory=forbidden)
    for current in [job(), job("anonymous")]:
        assert provider.acquire(current, tmp_path / "source").path.read_bytes() == b"anonymous original"
    assert not client.requests and anonymous.calls == 2


def test_cookie_snapshot_missing_never_uses_host_cookie_browser_or_anonymous(tmp_path):
    host = tmp_path / "host-cookie"; host.write_text("host private snapshot")
    client, anonymous, factories = Client(), Anonymous(), []
    provider = PlatformSourceProvider(client, anonymous, cookie_file=str(host),
        cookie_video_factory=lambda: factories.append(True) or strict_resolver())
    with pytest.raises(SourceDownloadError) as error:
        provider.acquire(job("cookie"), tmp_path / "source")
    assert error.value.code == "SOURCE_COOKIE_REQUIRED"
    assert not factories and anonymous.calls == 0 and host.read_text() == "host private snapshot"
    assert not (tmp_path / "source").exists()


def test_cookie_mode_uses_only_current_org_snapshot_and_progress_does_not_leak_on_switch(tmp_path):
    client, anonymous, captures, instances, callbacks = Client({"first": "first org", "second": "second org"}), Anonymous(), [], [], []
    host = tmp_path / "host-cookie"; host.write_text("host must never be used")
    def inspect(options):
        assert "cookiesfrombrowser" not in options
        captures.append((options["cookiefile"], Path(options["cookiefile"]).read_text()))
        assert Path(options["cookiefile"]).stat().st_mode & 0o777 == 0o600
        options["match_filter"]({"duration": 12, "filesize": 15})
        options["progress_hooks"][0]({"downloaded_bytes": 15})
    def factory():
        resolver = strict_resolver(inspect, cookie_file=str(host), cookies_from_browser="edge")
        instances.append(resolver)
        return resolver
    provider = PlatformSourceProvider(client, anonymous, cookie_video_factory=factory)
    provider.set_progress(callbacks.append)
    for org in ["first", "second"]:
        assert provider.acquire(job("cookie", org), tmp_path / org).path.read_bytes() == b"cookie original"
    assert [payload for _path, payload in captures] == ["first org", "second org"]
    assert len(instances) == 2 and all(resolver._progress is None for resolver in instances)
    assert all(not Path(path).exists() for path, _payload in captures)
    assert client.requests == ["first", "second"]
    callback = lambda _event: None
    provider.set_progress(callback)
    provider.acquire(job("anonymous"), tmp_path / "anonymous")
    assert anonymous.callbacks == [callback, None]
    assert len(callbacks) == 2 and client.requests == ["first", "second"]


def test_cookie_failure_never_falls_back_and_does_not_log_raw_values(tmp_path, caplog):
    secret = "sessionid=private-session https://private.invalid/?token=private-token"
    def fail(_options):
        raise RuntimeError("HTTP Error 403 " + secret)
    anonymous = Anonymous()
    provider = PlatformSourceProvider(Client({"first": "synthetic cookie"}), anonymous,
        cookie_video_factory=lambda: strict_resolver(fail))
    with pytest.raises(SourceDownloadError) as error:
        provider.acquire(job("cookie"), tmp_path / "source")
    assert error.value.code == "DOUYIN_ACCESS_REJECTED" and anonymous.calls == 0
    assert secret not in str(error.value) and "private-session" not in caplog.text and "private-token" not in caplog.text
    assert not (tmp_path / "source").exists() and not list(tmp_path.glob(".cookie-source-*"))


@pytest.mark.parametrize("duration,size", [(3601, 100), (12, 1024 ** 3 + 1)])
def test_known_cookie_metadata_over_limit_is_rejected_before_downloading(duration, size, tmp_path):
    file = tmp_path / "cookie"; file.write_text("synthetic cookie")
    reached = []
    def action(options):
        assert options["max_filesize"] == 1024 ** 3
        options["match_filter"]({"duration": duration, "filesize": size})
        reached.append("download")
    with pytest.raises(SourceDownloadError) as error:
        strict_resolver(action).download(URL, tmp_path / "source", cookie_file=file)
    assert error.value.code == "SOURCE_UNAVAILABLE" and not reached and not (tmp_path / "source").exists()


def test_cookie_download_checks_actual_probe_duration_and_final_size(tmp_path):
    file = tmp_path / "cookie"; file.write_text("synthetic cookie")
    resolver = strict_resolver()
    resolver._media_inspector = lambda _path: {"video": True, "duration": 3601}
    with pytest.raises(SourceDownloadError) as error:
        resolver.download(URL, tmp_path / "source", cookie_file=file)
    assert error.value.code == "SOURCE_UNAVAILABLE" and not (tmp_path / "source").exists()
    def oversized(options):
        # Sparse temporary output exercises a byte over the cap without RAM allocation.
        target = Path(options["outtmpl"].replace("%(ext)s", "mp4"))
        with target.open("wb") as output:
            output.truncate(1024 ** 3 + 1)
        return {"id": "1234567890123456789", "filepath": str(target), "duration": 12}
    with pytest.raises(SourceDownloadError) as error:
        strict_resolver(oversized).download(URL, tmp_path / "source", cookie_file=file)
    assert error.value.code == "SOURCE_UNAVAILABLE"
    assert not list(tmp_path.glob(".cookie-source-*"))


def test_cookie_final_exact_one_gib_and_sixty_minute_boundaries_are_validated(tmp_path):
    file = tmp_path / "cookie"; file.write_text("synthetic cookie")
    def sparse(options):
        target = Path(options["outtmpl"].replace("%(ext)s", "mp4"))
        with target.open("wb") as output:
            output.truncate(1024 ** 3)
        return {"id": "1234567890123456789", "filepath": str(target), "duration": 3600}
    resolver = strict_resolver(sparse)
    resolver._media_inspector = lambda _path: {"video": True, "duration": 3600}
    result = resolver.download(URL, tmp_path / "source", cookie_file=file)
    assert result.path.stat().st_size == 1024 ** 3 and result.metadata.duration_sec == 3600


def test_cancelled_cookie_download_stops_before_network(tmp_path):
    file = tmp_path / "cookie"; file.write_text("synthetic cookie")
    def forbidden(_options):
        raise AssertionError("cancelled source must not download")
    with pytest.raises(SourceDownloadError) as error:
        strict_resolver(forbidden, cancelled=lambda: True).download(URL, tmp_path / "source", cookie_file=file)
    assert error.value.code == "SOURCE_CANCELLED" and not (tmp_path / "source").exists()


def test_uploaded_task_ignores_cookie_selection_and_all_resolvers(tmp_path):
    client, anonymous = Client(), Anonymous()
    provider = PlatformSourceProvider(client, anonymous, cookie_video_factory=lambda: pytest.fail("no URL resolver"))
    assert provider.acquire(job("cookie", source_type="upload"), tmp_path / "source").path.read_bytes() == b"uploaded original"
    assert not client.requests and anonymous.calls == 0


@pytest.mark.parametrize("value", ["browser", "", False, {}, None])
def test_invalid_explicit_selection_fails_without_acquiring_credentials(value, tmp_path):
    current = job(); current = replace(current, source={**current.source, "collection_mode": value})
    client, anonymous = Client(), Anonymous()
    with pytest.raises(ValueError):
        PlatformSourceProvider(client, anonymous).acquire(current, tmp_path / "source")
    assert not client.requests and not anonymous.calls


def test_snapshot_client_rejects_anonymous_jobs_before_opening_network(tmp_path):
    with patch("liming_analyzer.api_client.urllib.request.urlopen", side_effect=AssertionError("network forbidden")):
        with pytest.raises(ValueError):
            AnalyzerApiClient("https://example.test", "synthetic", "worker").download_cookie_snapshot(job(), tmp_path / "cookie")


def test_snapshot_client_rejects_truncated_transmission_and_keeps_previous_owned_file(tmp_path):
    class Response:
        headers = {"Content-Length": "100"}
        def __enter__(self):
            return self
        def __exit__(self, *_args):
            return False
        def read(self, _count):
            if getattr(self, "read_once", False):
                return b""
            self.read_once = True
            return b"synthetic short cookie"
    destination = tmp_path / "cookie"; destination.write_text("previous owned snapshot")
    with patch("liming_analyzer.api_client.urllib.request.urlopen", return_value=Response()):
        with pytest.raises(AnalyzerApiError) as error:
            AnalyzerApiClient("https://example.test", "synthetic", "worker").download_cookie_snapshot(job("cookie"), destination)
    assert error.value.code == "COOKIE_SNAPSHOT_INCOMPLETE"
    assert destination.read_text() == "previous owned snapshot" and not (tmp_path / "cookie.part").exists()


def test_snapshot_http_error_never_replays_private_server_detail(tmp_path):
    secret = b'{"error":{"code":"COOKIE_FAILED","message":"sessionid=private-cookie"}}'
    failure = urllib.error.HTTPError("https://example.test/cookies", 503, "private-cookie", {}, io.BytesIO(secret))
    with patch("liming_analyzer.api_client.urllib.request.urlopen", side_effect=failure):
        with pytest.raises(AnalyzerApiError) as error:
            AnalyzerApiClient("https://example.test", "synthetic", "worker").download_cookie_snapshot(job("cookie"), tmp_path / "cookie")
    assert error.value.code == "COOKIE_DOWNLOAD_FAILED" and "private-cookie" not in str(error.value)
