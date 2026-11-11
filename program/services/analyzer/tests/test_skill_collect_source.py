"""Adapter behavior uses synthetic media; no external Douyin acceptance is implied."""
import errno
import hashlib
import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from liming_analyzer.adapters import AcquiredSource
from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.douyin_collector import CollectorError
from liming_analyzer.source_errors import SourceDownloadError, safe_source_diagnostic
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

    def test_unknown_internal_failure_logs_safe_stack_and_preserves_category(self):
        private = "cookie=private-cookie token=private-token https://cdn.invalid/private?signature=private-signature"

        def fail(_text, folder, **_kwargs):
            (Path(folder) / "partial").write_bytes(b"partial")
            raise OSError(errno.EBADF, private, "C:\\Users\\PrivateCustomer\\private.mp4")

        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "source"
            with self.assertLogs("liming_analyzer.sources", level="ERROR") as logs, self.assertRaises(SourceDownloadError) as raised:
                SkillCollectPublicVideoResolver(collector=fail).download(PAGE, destination)
            self.assertEqual(raised.exception.code, "SOURCE_INTERNAL_ERROR")
            message = "\n".join(logs.output)
            self.assertIn('"stage": "collector"', message)
            self.assertIn('"type": "OSError"', message)
            self.assertIn('"errno": 9', message)
            self.assertIn('"file": "sources.py"', message)
            for secret in ["private-cookie", "private-token", "private-signature", "PrivateCustomer", "cdn.invalid", str(directory), "raise OSError"]:
                self.assertNotIn(secret, message)
                self.assertNotIn(secret, str(raised.exception))
            self.assertFalse(destination.exists())
            self.assertFalse(list(Path(directory).glob(".source-capture-*")))

    def test_adapter_publish_error_is_distinct_from_platform_rejection(self):
        def fail(_text, _folder, **_kwargs):
            try:
                raise OSError(errno.EBADF, "cookie=private-cookie", "C:\\Users\\PrivateCustomer\\private.mp4")
            except OSError as error:
                failure = CollectorError("media_publish_failed", "fixed message", retryable=False, status=500)
                failure.stage = "sync_media"
                raise failure from error

        with tempfile.TemporaryDirectory() as directory:
            with self.assertLogs("liming_analyzer.sources", level="ERROR") as logs, self.assertRaises(SourceDownloadError) as raised:
                SkillCollectPublicVideoResolver(collector=fail).download(PAGE, Path(directory) / "source")
            self.assertEqual(raised.exception.code, "SOURCE_PUBLISH_FAILED")
            diagnostic = "\n".join(logs.output)
            self.assertIn('"stage": "sync_media"', diagnostic)
            self.assertIn('"errno": 9', diagnostic)
            self.assertIn('"type": "AppError"', diagnostic)
            self.assertNotIn("private-cookie", diagnostic)
            self.assertNotIn("PrivateCustomer", diagnostic)

    def test_provenance_publish_failure_removes_published_media_and_temporary_files(self):
        real_replace = os.replace

        def collect(_text, folder, **_kwargs):
            return synthetic_result(folder)

        def fail_provenance(source, destination):
            if str(destination).endswith(".acquisition.json"):
                raise PermissionError(errno.EACCES, "private-token in private exception", str(destination))
            return real_replace(source, destination)

        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "source"
            with patch("liming_analyzer.sources.os.replace", side_effect=fail_provenance), self.assertLogs("liming_analyzer.sources", level="ERROR") as logs, self.assertRaises(SourceDownloadError) as raised:
                SkillCollectPublicVideoResolver(collector=collect).download(PAGE, destination)
            self.assertEqual(raised.exception.code, "SOURCE_PUBLISH_FAILED")
            diagnostic = "\n".join(logs.output)
            self.assertIn('"stage": "publish_provenance"', diagnostic)
            self.assertIn('"type": "PermissionError"', diagnostic)
            self.assertNotIn("private-token", diagnostic)
            self.assertNotIn(directory, diagnostic)
            self.assertFalse(destination.exists())
            self.assertFalse(destination.with_name("source.acquisition.json").exists())
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_safe_diagnostic_omits_messages_and_external_paths_in_chained_exceptions(self):
        try:
            try:
                raise OSError(errno.EIO, "private customer body", "/private/customer/secret.mp4")
            except OSError as error:
                raise RuntimeError("https://cdn.invalid/?token=secret") from error
        except RuntimeError as error:
            diagnostic = safe_source_diagnostic(error, "untrusted stage with private body")
        serialized = json.dumps(diagnostic)
        self.assertEqual(diagnostic["stage"], "collector")
        self.assertEqual([row["type"] for row in diagnostic["errors"]], ["RuntimeError", "OSError"])
        self.assertEqual(diagnostic["errors"][1]["errno"], errno.EIO)
        self.assertTrue(diagnostic["errors"][0]["stack"])
        for secret in ["customer", "secret", "cdn.invalid", "untrusted stage", str(Path(__file__).resolve())]:
            self.assertNotIn(secret, serialized)

    def test_cleanup_failure_keeps_safe_error_and_attempts_both_artifacts(self):
        real_replace, real_unlink = os.replace, Path.unlink
        cleaned = []

        def collect(_text, folder, **_kwargs):
            return synthetic_result(folder)

        def fail_provenance(source, target):
            if str(target).endswith(".acquisition.json"):
                raise PermissionError(errno.EACCES, "private-provenance-token", str(target))
            return real_replace(source, target)

        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "source"

            def fail_media_cleanup(path, *args, **kwargs):
                cleaned.append(path)
                if path == destination:
                    raise PermissionError(errno.EACCES, "private-cleanup-token", str(path))
                return real_unlink(path, *args, **kwargs)

            with patch("liming_analyzer.sources.os.replace", side_effect=fail_provenance), patch.object(Path, "unlink", fail_media_cleanup), self.assertLogs("liming_analyzer.sources", level="ERROR") as logs, self.assertRaises(SourceDownloadError) as raised:
                SkillCollectPublicVideoResolver(collector=collect).download(PAGE, destination)
            self.assertEqual(raised.exception.code, "SOURCE_PUBLISH_FAILED")
            self.assertIn(destination, cleaned)
            self.assertIn(destination.with_name("source.acquisition.json"), cleaned)
            diagnostic = "\n".join(logs.output)
            self.assertIn('"stage": "cleanup_source"', diagnostic)
            for secret in ["private-provenance-token", "private-cleanup-token", directory]:
                self.assertNotIn(secret, diagnostic)
                self.assertNotIn(secret, str(raised.exception))
            real_unlink(destination)


if __name__ == "__main__":
    unittest.main()
