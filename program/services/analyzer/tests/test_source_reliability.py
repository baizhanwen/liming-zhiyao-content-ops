import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.sources import PlatformSourceProvider, YtDlpPublicVideoResolver
from liming_analyzer.source_errors import SourceDownloadError
from liming_analyzer.worker import classify_worker_error


def job(org="org-1"):
    return ClaimedJob("job-" + org, org, "project-1", "video-1", "url", "queued", 1, 2, {"source_url": "https://www.douyin.com/video/1", "collection_mode": "cookie"})


class SnapshotClient:
    def __init__(self, snapshots=None):
        self.snapshots = snapshots or {}

    def download_cookie_snapshot(self, claimed, destination):
        snapshot = self.snapshots.get(claimed.organization_id)
        if snapshot is None:
            destination.unlink(missing_ok=True)
            return False
        destination.write_text(snapshot, encoding="utf-8")
        return True


def downloader_factory(seen, action):
    class Downloader:
        def __init__(self, options):
            self.options = options
            seen.append(options)

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def extract_info(self, _url, download=True):
            action(self.options)
            output = Path(self.options["outtmpl"].replace("%(ext)s", "mp4"))
            output.write_bytes(b"media")
            return {"id": "1", "requested_downloads": [{"filepath": str(output)}]}

    return Downloader


def organization_resolver(factory, **options):
    return YtDlpPublicVideoResolver(factory, organization_cookie_only=True,
        media_inspector=lambda _path: {"video": True, "audio": True, "duration": 12}, **options)


class SourceReliabilityTests(unittest.TestCase):
    def test_missing_remote_snapshot_never_falls_back_to_manually_imported_host_cookie(self):
        with tempfile.TemporaryDirectory() as directory:
            local = Path(directory) / "manual-cookies.txt"
            local.write_text("manual snapshot", encoding="utf-8")
            seen = []
            contents = []
            resolver = YtDlpPublicVideoResolver(downloader_factory(seen, lambda options: contents.append(Path(options["cookiefile"]).read_text(encoding="utf-8"))), cookie_file=str(local))
            provider = PlatformSourceProvider(SnapshotClient(), object(), cookie_file=str(local), cookie_video_factory=lambda: resolver)
            with self.assertRaises(SourceDownloadError) as error:
                provider.acquire(job(), Path(directory) / "source")
            self.assertEqual(error.exception.code, "SOURCE_COOKIE_REQUIRED")
            self.assertEqual(local.read_text(encoding="utf-8"), "manual snapshot")
            self.assertEqual(contents, [])

    def test_org_snapshot_does_not_replace_local_fallback_or_leak_to_next_org(self):
        with tempfile.TemporaryDirectory() as directory:
            local = Path(directory) / "manual-cookies.txt"
            local.write_text("host fallback", encoding="utf-8")
            captured = []
            seen = []
            resolver = organization_resolver(downloader_factory(seen, lambda options: captured.append(Path(options["cookiefile"]).read_text(encoding="utf-8"))), cookie_file=str(local), cookies_from_browser="edge")
            provider = PlatformSourceProvider(SnapshotClient({"org-1": "first org"}), object(), cookie_file=str(local), cookie_video_factory=lambda: resolver)
            provider.acquire(job("org-1"), Path(directory) / "first")
            with self.assertRaises(SourceDownloadError) as error:
                provider.acquire(job("org-2"), Path(directory) / "second")
            self.assertEqual(error.exception.code, "SOURCE_COOKIE_REQUIRED")
            self.assertEqual(captured, ["first org"])
            self.assertTrue(all("cookiesfrombrowser" not in options for options in seen))
            self.assertEqual(local.read_text(encoding="utf-8"), "host fallback")
            self.assertTrue(all(not Path(options["cookiefile"]).exists() for options in seen))

    def test_remote_snapshot_works_without_a_configured_local_cookie_path(self):
        with tempfile.TemporaryDirectory() as directory:
            captured = []
            resolver = organization_resolver(downloader_factory([], lambda options: captured.append(Path(options["cookiefile"]).read_text(encoding="utf-8"))))
            PlatformSourceProvider(SnapshotClient({"org-1": "uploaded"}), object(), cookie_video_factory=lambda: resolver).acquire(job(), Path(directory) / "source")
            self.assertEqual(captured, ["uploaded"])

    def test_downloader_cookie_writes_never_modify_the_imported_master(self):
        with tempfile.TemporaryDirectory() as directory:
            master = Path(directory) / "cookies.txt"
            master.write_text("original snapshot", encoding="utf-8")
            def mutate(options):
                Path(options["cookiefile"]).write_text("yt-dlp cookiejar save", encoding="utf-8")
            resolver = YtDlpPublicVideoResolver(downloader_factory([], mutate), cookie_file=str(master))
            resolver.download("https://www.douyin.com/video/1", Path(directory) / "source")
            self.assertEqual(master.read_text(encoding="utf-8"), "original snapshot")

    def test_network_failure_is_not_overwritten_by_browser_cookie_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            cookie = Path(directory) / "cookies.txt"
            cookie.write_text("snapshot", encoding="utf-8")
            seen = []
            def fail(options):
                if "cookiefile" in options:
                    raise TimeoutError("video request timed out")
                raise RuntimeError("Could not copy Chrome cookie database")
            resolver = YtDlpPublicVideoResolver(downloader_factory(seen, fail), cookie_file=str(cookie), cookies_from_browser="edge")
            with patch("liming_analyzer.sources.time.sleep"), self.assertRaises(RuntimeError) as raised:
                resolver.download("https://www.douyin.com/video/1", Path(directory) / "source")
            self.assertEqual(classify_worker_error(raised.exception)[0], "SOURCE_NETWORK_FAILED")
            self.assertEqual(len(seen), 2)
            self.assertTrue(all("cookiefile" in options for options in seen))

    def test_fresh_cookies_hint_is_not_proof_the_login_has_expired(self):
        with tempfile.TemporaryDirectory() as directory:
            def reject(_options):
                raise RuntimeError("Fresh cookies (not necessarily logged in) are needed")
            resolver = YtDlpPublicVideoResolver(downloader_factory([], reject))
            with self.assertRaises(RuntimeError) as raised:
                resolver.download("https://www.douyin.com/video/1", Path(directory) / "source")
            self.assertEqual(classify_worker_error(raised.exception)[0], "DOUYIN_ACCESS_REJECTED")

    def test_browser_database_lock_has_its_own_error_code(self):
        with tempfile.TemporaryDirectory() as directory:
            def locked(_options):
                raise RuntimeError("Could not copy Chrome cookie database")
            resolver = YtDlpPublicVideoResolver(downloader_factory([], locked), cookies_from_browser="edge")
            with self.assertRaises(RuntimeError) as raised:
                resolver.download("https://www.douyin.com/video/1", Path(directory) / "source")
            self.assertEqual(classify_worker_error(raised.exception)[0], "DOUYIN_BROWSER_UNAVAILABLE")

    def test_rate_limit_is_not_reported_as_cookie_expiration(self):
        with tempfile.TemporaryDirectory() as directory:
            def limited(_options):
                raise RuntimeError("HTTP Error 429 while requesting with cookies")
            resolver = YtDlpPublicVideoResolver(downloader_factory([], limited))
            with self.assertRaises(RuntimeError) as raised:
                resolver.download("https://www.douyin.com/video/1", Path(directory) / "source")
            self.assertEqual(classify_worker_error(raised.exception)[0], "SOURCE_RATE_LIMITED")

    def test_swallowed_network_warning_takes_priority_over_fresh_cookies_error(self):
        with tempfile.TemporaryDirectory() as directory:
            def rejected(options):
                options["logger"].warning("Failed to download web detail JSON: HTTP Error 503")
                options["logger"].error("Fresh cookies (not necessarily logged in) are needed")
                raise RuntimeError("Fresh cookies (not necessarily logged in) are needed")
            seen = []
            resolver = YtDlpPublicVideoResolver(downloader_factory(seen, rejected))
            with patch("liming_analyzer.sources.time.sleep") as sleep, self.assertRaises(RuntimeError) as raised:
                resolver.download("https://www.douyin.com/video/1", Path(directory) / "source")
            self.assertEqual(classify_worker_error(raised.exception)[0], "SOURCE_NETWORK_FAILED")
            self.assertEqual(len(seen), 2)
            sleep.assert_called_once_with(3)

    def test_transient_download_recovers_without_user_changing_cookies(self):
        with tempfile.TemporaryDirectory() as directory:
            cookie = Path(directory) / "cookies.txt"
            cookie.write_text("unchanged cookie", encoding="utf-8")
            seen = []
            def once(options):
                self.assertEqual(Path(options["cookiefile"]).read_text(encoding="utf-8"), "unchanged cookie")
                if len(seen) == 1:
                    raise TimeoutError("request timed out")
            resolver = YtDlpPublicVideoResolver(downloader_factory(seen, once), cookie_file=str(cookie), cookies_from_browser="edge")
            with patch("liming_analyzer.sources.time.sleep"):
                result = resolver.download("https://www.douyin.com/video/1", Path(directory) / "source")
            self.assertEqual(result.path.read_bytes(), b"media")
            self.assertEqual(len(seen), 2)
            self.assertTrue(all("cookiesfrombrowser" not in options for options in seen))

    def test_cookie_rejection_can_fall_back_to_browser_but_not_overwrite_primary_error(self):
        with tempfile.TemporaryDirectory() as directory:
            cookie = Path(directory) / "cookies.txt"
            cookie.write_text("snapshot", encoding="utf-8")
            seen = []
            def reject(options):
                if "cookiefile" in options:
                    raise RuntimeError("Fresh cookies are needed")
                raise RuntimeError("Could not copy Chrome cookie database")
            resolver = YtDlpPublicVideoResolver(downloader_factory(seen, reject), cookie_file=str(cookie), cookies_from_browser="edge")
            with self.assertRaises(RuntimeError) as raised:
                resolver.download("https://www.douyin.com/video/1", Path(directory) / "source")
            self.assertEqual(classify_worker_error(raised.exception)[0], "DOUYIN_ACCESS_REJECTED")
            self.assertEqual(len(seen), 2)

    def test_two_organizations_can_fetch_their_snapshots_concurrently(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier, get_ident
        barrier = Barrier(2)
        expected_by_thread = {}
        class BoundSnapshotClient(SnapshotClient):
            def download_cookie_snapshot(self, claimed, destination):
                expected_by_thread[get_ident()] = claimed.organization_id
                return super().download_cookie_snapshot(claimed, destination)
        with tempfile.TemporaryDirectory() as directory:
            def check(options):
                barrier.wait(timeout=5)
                expected = expected_by_thread[get_ident()]
                self.assertEqual(Path(options["cookiefile"]).read_text(encoding="utf-8"), expected)
            provider = PlatformSourceProvider(BoundSnapshotClient({"org-1": "org-1", "org-2": "org-2"}), object(),
                cookie_video_factory=lambda: organization_resolver(downloader_factory([], check)))
            with ThreadPoolExecutor(max_workers=2) as executor:
                tasks = [executor.submit(provider.acquire, job(org), Path(directory) / name) for org, name in [("org-1", "first"), ("org-2", "second")]]
                for task in tasks:
                    self.assertEqual(task.result().path.read_bytes(), b"media")


if __name__ == "__main__":
    unittest.main()
