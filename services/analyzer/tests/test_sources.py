import unittest

from liming_analyzer.sources import is_allowed_douyin_url


class SourceTests(unittest.TestCase):
    def test_only_https_douyin_hosts_are_allowed(self):
        self.assertTrue(is_allowed_douyin_url("https://v.douyin.com/abc"))
        self.assertTrue(is_allowed_douyin_url("https://www.iesdouyin.com/share/video/1"))
        self.assertFalse(is_allowed_douyin_url("http://v.douyin.com/abc"))
        self.assertFalse(is_allowed_douyin_url("https://douyin.com.evil.example/abc"))


if __name__ == "__main__":
    unittest.main()
