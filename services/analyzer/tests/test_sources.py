import tempfile
import unittest
from http.cookiejar import Cookie
from pathlib import Path

from liming_analyzer.cookie_snapshot import is_douyin_cookie, snapshot_browser_cookies
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
        with self.assertRaisesRegex(ValueError, "unsupported cookie browser"):
            parse_browser_cookie_spec("unknown-browser")

    def test_cookie_failures_return_an_actionable_local_message(self):
        resolver = YtDlpPublicVideoResolver(
            CookieFailureDownloader,
            cookies_from_browser="edge",
        )
        with (
            tempfile.TemporaryDirectory() as directory,
            self.assertRaisesRegex(RuntimeError, r"refresh-douyin-cookies\.bat"),
        ):
            resolver.download(
                "https://www.douyin.com/video/1",
                Path(directory) / "source",
            )

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


if __name__ == "__main__":
    unittest.main()
