"""Adapter behavior uses synthetic media; no external Douyin acceptance is implied."""
import hashlib
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from liming_analyzer.adapters import AcquiredSource
from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.douyin_collector import CollectorError
from liming_analyzer.source_errors import SourceDownloadError
from liming_analyzer.sources import PlatformSourceProvider, SkillCollectPublicVideoResolver

PAGE = "https://www.douyin.com/video/1234567890123456789"
MEDIA = b"self-authored-synthetic-video-fixture"


def claimed(source_type="url"):
    return ClaimedJob(
        "job-1", "org-1", "project-1", "video-1", source_type,
        "queued", 1, 2, {"source_url": PAGE},
    )


def synthetic_result(folder):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    media = folder / "video-collector-result.mp4"
    media.write_bytes(MEDIA)
    return {
        "media_path": str(media),
        "video_id": "1234567890123456789",
        "source_url": PAGE,
        "title": "synthetic target title",
        "sha256": hashlib.sha256(MEDIA).hexdigest(),
        "size_bytes": len(MEDIA),
        "duration": 12.4,
        "has_video": True,
        "has_audio": False,
        "limitations": ["synthetic silent fixture"],
        "identity_verified": True,
        "coverage": [[0, len(MEDIA)]],
        "acquisition_method": "synthetic_fixture",
    }


class NoCookieClient:
    def download_cookie_snapshot(self, *_args, **_kwargs):
        raise AssertionError("anonymous acquisition must not fetch organization cookies")

    def download_upload_source(self, _job, destination):
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(MEDIA)
        return destination


class SkillCollectSourceTests(unittest.TestCase):
    def test_anonymous_collection_preserves_source_contract_without_cookie_snapshot(self):
        seen = []

        def collect(text, folder, **kwargs):
            seen.append((text, Path(folder), kwargs))
            return synthetic_result(folder)

        resolver = SkillCollectPublicVideoResolver(collector=collect, ffmpeg="fixture-ffmpeg", ffprobe="fixture-ffprobe", browser_timeout=42)
        with tempfile.TemporaryDirectory() as directory:
            result = PlatformSourceProvider(
                NoCookieClient(), resolver,
                cookie_file=str(Path(directory) / "must-not-read-cookies.txt"),
            ).acquire(claimed(), Path(directory) / "source")
            self.assertIsInstance(result, AcquiredSource)
            self.assertEqual(result.path, Path(directory) / "source")
            self.assertEqual(result.path.read_bytes(), MEDIA)
            evidence = json.loads(result.path.with_name("source.acquisition.json").read_text())
            self.assertFalse(evidence["has_audio"])
            self.assertEqual(evidence["limitations"], ["synthetic silent fixture"])
            self.assertEqual(evidence["coverage"], [[0, len(MEDIA)]])
            self.assertEqual(result.metadata.platform_work_id, "1234567890123456789")
            self.assertEqual(result.metadata.title, "synthetic target title")
            self.assertEqual(result.metadata.duration_sec, 12)
            for field in ("author_name", "published_at", "plays", "likes", "comments", "favorites", "shares"):
                self.assertIsNone(getattr(result.metadata, field))
        self.assertEqual(seen[0][0], PAGE)
        self.assertNotIn("cookie_file", seen[0][2])
        self.assertEqual(seen[0][2]["ffmpeg"], "fixture-ffmpeg")
        self.assertEqual(seen[0][2]["ffprobe"], "fixture-ffprobe")
        self.assertEqual(seen[0][2]["browser_timeout"], 42)
        self.assertFalse(resolver.uses_cookie_snapshots)

    def test_uploaded_sources_keep_the_existing_download_route(self):
        def forbidden(*_args, **_kwargs):
            raise AssertionError("uploads must not run the Douyin collector")

        with tempfile.TemporaryDirectory() as directory:
            result = PlatformSourceProvider(
                NoCookieClient(), SkillCollectPublicVideoResolver(collector=forbidden),
            ).acquire(claimed("upload"), Path(directory) / "source")
            self.assertEqual(result.path.read_bytes(), MEDIA)
            self.assertIsNone(result.metadata)

    def test_each_collection_uses_a_separate_task_folder(self):
        seen = []

        def collect(_text, folder, **_kwargs):
            seen.append(Path(folder))
            return synthetic_result(folder)

        resolver = SkillCollectPublicVideoResolver(collector=collect)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(resolver.download, PAGE, root / name / "source") for name in ("first", "second")]
                outputs = [future.result() for future in futures]
            self.assertEqual(len(set(seen)), 2)
            self.assertNotEqual(outputs[0].path, outputs[1].path)
            self.assertEqual([output.path.read_bytes() for output in outputs], [MEDIA, MEDIA])
            self.assertTrue(all(folder.is_relative_to(root.resolve()) for folder in seen))

    def test_non_douyin_input_is_rejected_before_collecting(self):
        def forbidden(*_args, **_kwargs):
            raise AssertionError("invalid input must not reach the collector")

        resolver = SkillCollectPublicVideoResolver(collector=forbidden)
        with tempfile.TemporaryDirectory() as directory, self.assertRaises((ValueError, SourceDownloadError)):
            resolver.download("https://outside.invalid/video/123", Path(directory) / "source")

    def test_media_outside_the_task_directory_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            outside = Path(directory) / "unrelated.mp4"
            outside.write_bytes(MEDIA)

            def escape(_text, folder, **_kwargs):
                result = synthetic_result(folder)
                result["media_path"] = str(outside)
                return result

            with self.assertRaises(SourceDownloadError) as raised:
                SkillCollectPublicVideoResolver(collector=escape).download(PAGE, Path(directory) / "source")
            self.assertEqual(raised.exception.code, "SOURCE_DOWNLOAD_FAILED")
            self.assertEqual(outside.read_bytes(), MEDIA)
            self.assertFalse((Path(directory) / "source").exists())

    def test_real_collector_error_codes_keep_actionable_worker_categories(self):
        codes = {
            "douyin_browser_timeout": "SOURCE_NETWORK_FAILED",
            "douyin_fetch": "SOURCE_NETWORK_FAILED",
            "douyin_browser_runtime": "SOURCE_RUNTIME_UNAVAILABLE",
            "douyin_not_found": "SOURCE_UNAVAILABLE",
            "douyin_access_restricted": "DOUYIN_ACCESS_REJECTED",
            "douyin_login_required": "DOUYIN_ACCESS_REJECTED",
            "douyin_verification_required": "DOUYIN_ACCESS_REJECTED",
            "douyin_rate_limited": "SOURCE_RATE_LIMITED",
            "cancelled": "SOURCE_CANCELLED",
        }
        with tempfile.TemporaryDirectory() as directory:
            for collector_code, worker_code in codes.items():
                with self.subTest(collector_code=collector_code):
                    def fail(_text, _folder, _code=collector_code, **_kwargs):
                        raise CollectorError(_code, "private request diagnostic")

                    with self.assertRaises(SourceDownloadError) as raised:
                        SkillCollectPublicVideoResolver(collector=fail).download(PAGE, Path(directory) / "source")
                    self.assertEqual(raised.exception.code, worker_code)
                    self.assertNotIn("private request", str(raised.exception))

    def test_collector_failure_is_safe_and_never_creates_a_successful_source(self):
        def fail(_text, folder, **_kwargs):
            Path(folder).mkdir(parents=True, exist_ok=True)
            (Path(folder) / "partial").write_bytes(b"partial")
            raise CollectorError("douyin_browser_timeout", "private signed-url=https://cdn.invalid/private?signature=secret", True)

        with tempfile.TemporaryDirectory() as directory:
            resolver = SkillCollectPublicVideoResolver(collector=fail)
            with self.assertRaises(SourceDownloadError) as raised:
                resolver.download(PAGE, Path(directory) / "source")
            self.assertEqual(raised.exception.code, "SOURCE_NETWORK_FAILED")
            self.assertNotIn("signature", str(raised.exception))
            self.assertNotIn("cdn.invalid", str(raised.exception))
            self.assertFalse((Path(directory) / "source").exists())


if __name__ == "__main__":
    unittest.main()
