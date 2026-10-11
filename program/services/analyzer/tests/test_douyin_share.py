import json
import unittest
from unittest.mock import patch

from yt_dlp.extractor.tiktok import DouyinIE
from yt_dlp.utils import ExtractorError

from liming_analyzer.douyin_share import (
    DouyinShareFallbackIE, create_public_video_downloader, share_video_detail,
)


def page(items, status=0):
    data = {"loaderData": {"video_layout": None, "video_(id)/page": {
        "videoInfoRes": {"status_code": status, "item_list": items},
    }}}
    return f"<script>window._ROUTER_DATA = {json.dumps(data)};</script>"


class DouyinShareTests(unittest.TestCase):
    def setUp(self):
        self.video = {"aweme_id": "123456789", "desc": "sample", "video": {"bit_rate": [], "play_addr": {"url_list": ["https://example.test/video.mp4"]}}}
        self.url = "https://www.douyin.com/video/123456789"

    def test_only_requested_video_is_selected_from_share_page(self):
        unrelated = {**self.video, "aweme_id": "987654321"}
        self.assertEqual(share_video_detail(page([unrelated, self.video]), "123456789"), self.video)
        self.assertIsNone(share_video_detail(page([unrelated]), "123456789"))
        self.assertIsNone(share_video_detail(page([self.video], status=404), "123456789"))

    def test_missing_malformed_and_challenge_pages_have_no_metadata(self):
        for content in ("<html>Verify login</html>", "window._ROUTER_DATA = {bad json}", "window._ROUTER_DATA = []", page([])):
            self.assertIsNone(share_video_detail(content, "123456789"))

    def test_share_page_null_bitrates_are_normalized_for_native_parser(self):
        video = {**self.video, "video": {**self.video["video"], "bit_rate": None, "duration": 12000}}
        detail = share_video_detail(page([video]), "123456789")
        self.assertEqual(detail["video"]["bit_rate"], [])
        with create_public_video_downloader({"quiet": True}) as downloader:
            result = downloader.get_info_extractor("DouyinShareFallback")._parse_aweme_video_app(detail)
            self.assertEqual(result["id"], "123456789")
            self.assertEqual(result["duration"], 12)
            self.assertTrue(result["formats"])

    def test_existing_extractor_success_does_not_fetch_share_page(self):
        extractor = DouyinShareFallbackIE()
        expected = {"id": "123456789", "formats": [{"url": "https://example.test/video.mp4"}]}
        with patch.object(DouyinIE, "_real_extract", return_value=expected), patch.object(extractor, "_download_webpage") as fetch:
            self.assertEqual(extractor._real_extract(self.url), expected)
            fetch.assert_not_called()

    def test_access_error_falls_back_to_matching_share_video(self):
        extractor = DouyinShareFallbackIE()
        result = {"id": "123456789", "formats": [{"url": "https://example.test/video.mp4"}]}
        with patch.object(DouyinIE, "_real_extract", side_effect=ExtractorError("Fresh cookies (not necessarily logged in) are needed")), patch.object(extractor, "_download_webpage", return_value=page([self.video])) as fetch, patch.object(extractor, "_parse_aweme_video_app", return_value=result) as parse:
            self.assertEqual(extractor._real_extract(self.url), result)
            self.assertEqual(fetch.call_args.args[0], "https://www.iesdouyin.com/share/video/123456789/")
            self.assertIn("iPhone", fetch.call_args.kwargs["headers"]["User-Agent"])
            parse.assert_called_once_with(self.video)

    def test_missing_video_preserves_original_access_error(self):
        extractor = DouyinShareFallbackIE()
        with patch.object(DouyinIE, "_real_extract", side_effect=ExtractorError("Fresh cookies are needed")), patch.object(extractor, "_download_webpage", return_value=page([])) as fetch, patch.object(extractor, "_sleep"):
            with self.assertRaisesRegex(ExtractorError, "Fresh cookies"):
                extractor._real_extract(self.url)
            self.assertEqual(fetch.call_count, 2)

    def test_empty_share_response_gets_one_bounded_retry(self):
        extractor = DouyinShareFallbackIE()
        result = {"id": "123456789", "formats": [{"url": "https://example.test/video.mp4"}]}
        with patch.object(DouyinIE, "_real_extract", side_effect=ExtractorError("Fresh cookies are needed")), patch.object(extractor, "_download_webpage", side_effect=[page([]), page([self.video])]) as fetch, patch.object(extractor, "_parse_aweme_video_app", return_value=result), patch.object(extractor, "_sleep") as sleep:
            self.assertEqual(extractor._real_extract(self.url), result)
            self.assertEqual(fetch.call_count, 2)
            sleep.assert_called_once_with(1, "123456789")

    def test_unrelated_errors_do_not_trigger_fallback(self):
        extractor = DouyinShareFallbackIE()
        with patch.object(DouyinIE, "_real_extract", side_effect=ExtractorError("Video is unavailable")), patch.object(extractor, "_download_webpage") as fetch:
            with self.assertRaisesRegex(ExtractorError, "unavailable"):
                extractor._real_extract(self.url)
            fetch.assert_not_called()

    def test_fallback_precedes_builtin_douyin_and_generic_extractors(self):
        with create_public_video_downloader({"quiet": True}) as downloader:
            extractor = next(item for item in downloader._ies.values() if item.suitable(self.url))
            self.assertIsInstance(extractor, DouyinShareFallbackIE)


if __name__ == "__main__":
    unittest.main()
