import tempfile
import unittest
import io
import sys
from contextlib import redirect_stderr
from http.cookiejar import Cookie
from pathlib import Path

from liming_analyzer.cookie_snapshot import (
    import_cookie_file,
    inspect_browser_authentication,
    is_douyin_cookie,
    snapshot_browser_cookies,
)
from liming_analyzer.sources import (
    YtDlpPublicVideoResolver,
    is_allowed_douyin_url,
    parse_browser_cookie_spec,
)


class CookieFailureDownloader:
    def __init__(self, _options):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def extract_info(self, _url, download=True):
        raise RuntimeError("Fresh cookies are needed")


def make_cookie(domain, name):
    return Cookie(
        0, name, "value", None, False, domain, True, domain.startswith("."), "/", True,
        False, None, True, None, None, {}, False,
    )


class SnapshotDownloader:
    def __init__(self, _options):
        self.cookiejar = [
            make_cookie(".douyin.com", "sessionid"),
            make_cookie("accounts.example.com", "unrelated"),
        ]

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class SourceTests(unittest.TestCase):
    def test_only_https_douyin_hosts_are_allowed(self):
        self.assertTrue(is_allowed_douyin_url("https://v.douyin.com/abc"))
        self.assertTrue(is_allowed_douyin_url("https://www.iesdouyin.com/share/video/1"))
        self.assertFalse(is_allowed_douyin_url("http://v.douyin.com/abc"))
        self.assertFalse(is_allowed_douyin_url("https://douyin.com.evil.example/abc"))

    def test_browser_cookie_spec_is_allowlisted_and_supports_profiles(self):
        self.assertEqual(parse_browser_cookie_spec("edge"), ("edge", None, None, None))
        self.assertEqual(parse_browser_cookie_spec("Chrome:Default"), ("chrome", "Default", None, None))
        self.assertIsNone(parse_browser_cookie_spec(""))
        self.assertIsNone(parse_browser_cookie_spec("none"))
        self.assertIsNone(parse_browser_cookie_spec("DISABLED"))
        with self.assertRaisesRegex(ValueError, "unsupported cookie browser"):
            parse_browser_cookie_spec("unknown-browser")

    def test_cookie_failures_return_an_actionable_local_message(self):
        resolver = YtDlpPublicVideoResolver(
            CookieFailureDownloader,
            cookies_from_browser="edge",
        )
        with (
            tempfile.TemporaryDirectory() as directory,
            self.assertRaisesRegex(RuntimeError, r"分析主机浏览器登录态"),
        ):
            resolver.download(
                "https://www.douyin.com/video/1",
                Path(directory) / "source",
            )

    def test_public_download_passes_the_resolved_ffmpeg_location_to_yt_dlp(self):
        captured = {}

        class Downloader:
            def __init__(self, options):
                captured.update(options)

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def extract_info(self, _url, download=True):
                output = Path(captured["outtmpl"].replace("%(ext)s", "mp4"))
                output.write_bytes(b"media")
                return {"id": "work-1", "requested_downloads": [{"filepath": str(output)}]}

        with tempfile.TemporaryDirectory() as directory:
            result = YtDlpPublicVideoResolver(
                Downloader,
                ffmpeg_location=r"C:\media\ffmpeg.exe",
            ).download(
                "https://www.douyin.com/video/1",
                Path(directory) / "source",
            )
        self.assertEqual(result.metadata.platform_work_id, "work-1")
        self.assertEqual(captured["ffmpeg_location"], r"C:\media\ffmpeg.exe")

    def test_browser_auth_detects_real_session_cookie_without_exposing_values(self):
        status = inspect_browser_authentication("edge", SnapshotDownloader)
        self.assertEqual(status["status"], "logged_in")
        self.assertEqual(status["browser"], "edge")
        self.assertNotIn("value", status["message"])

    def test_browser_auth_rejects_non_session_douyin_cookie(self):
        class AnonymousDownloader(SnapshotDownloader):
            def __init__(self, _options):
                self.cookiejar = [make_cookie(".douyin.com", "ttwid")]

        status = inspect_browser_authentication("edge", AnonymousDownloader)
        self.assertEqual(status["status"], "not_logged_in")

    def test_background_browser_probe_reports_state_without_raw_error_spam(self):
        class LockedBrowser(SnapshotDownloader):
            def __init__(self, options):
                self.options = options

            @property
            def cookiejar(self):
                message = "Could not copy Chrome cookie database"
                if self.options.get("logger"):
                    self.options["logger"].error(message)
                else:
                    print(message, file=sys.stderr)
                raise RuntimeError(message)

        output = io.StringIO()
        with redirect_stderr(output):
            for _ in range(3):
                status = inspect_browser_authentication("edge", LockedBrowser)
                self.assertEqual(status["status"], "unavailable")
                self.assertIn("占用", status["message"])
        self.assertEqual(output.getvalue(), "")
    def test_cookie_snapshot_keeps_only_douyin_domains(self):
        self.assertTrue(is_douyin_cookie(make_cookie(".douyin.com", "sessionid")))
        self.assertFalse(is_douyin_cookie(make_cookie("example.com", "sessionid")))
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "cookies.txt"
            count = snapshot_browser_cookies("edge", output, SnapshotDownloader)
            contents = output.read_text(encoding="utf-8")
        self.assertEqual(count, 1)
        self.assertIn("sessionid", contents)
        self.assertNotIn("unrelated", contents)

    def test_cookie_file_import_keeps_only_douyin_domains(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "exported.txt"
            output = Path(directory) / "snapshot.txt"
            source.write_text(
                "# Netscape HTTP Cookie File\n"
                ".douyin.com\tTRUE\t/\tTRUE\t0\tsessionid\tvalue\n"
                ".example.com\tTRUE\t/\tTRUE\t0\tunrelated\tvalue\n",
                encoding="utf-8",
            )
            count = import_cookie_file(source, output)
            contents = output.read_text(encoding="utf-8")
        self.assertEqual(count, 1)
        self.assertIn("sessionid", contents)
        self.assertNotIn("unrelated", contents)


if __name__ == "__main__":
    unittest.main()
