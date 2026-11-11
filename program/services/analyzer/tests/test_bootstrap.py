from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from liming_analyzer.bootstrap import (
    _configure_paddlex_model_source,
    _initialize_model_with_cache_repair,
    _remove_cache_entries,
    _resolve_media_executable,
    _windows_model_cache,
)


class ModelCacheRecoveryTests(unittest.TestCase):
    def test_media_executable_resolution_returns_an_absolute_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            executable = Path(temporary) / "ffprobe.exe"
            executable.write_bytes(b"binary")

            resolved = _resolve_media_executable(str(executable), "ffprobe")

            self.assertEqual(resolved, str(executable.resolve()))

    def test_missing_media_executable_has_repair_guidance(self) -> None:
        with self.assertRaisesRegex(RuntimeError, r"setup-analyzer\.bat"):
            _resolve_media_executable("definitely-missing-ffmpeg-command", "ffmpeg")

    def test_windows_cache_avoids_non_ascii_user_profile(self) -> None:
        cache = _windows_model_cache(
            {
                "LOCALAPPDATA": r"C:\Users\白湛文\AppData\Local",
                "PROGRAMDATA": r"C:\ProgramData",
                "PUBLIC": r"C:\Users\Public",
                "SystemDrive": "C:",
            }
        )

        self.assertEqual(cache, r"C:\ProgramData\LimingZhiyao\model-cache")
        cache.encode("ascii")

    def test_windows_cache_falls_back_to_public_when_program_data_is_not_ascii(self) -> None:
        cache = _windows_model_cache(
            {
                "PROGRAMDATA": r"D:\公共数据",
                "PUBLIC": r"C:\Users\Public",
                "SystemDrive": "C:",
            }
        )

        self.assertEqual(cache, r"C:\Users\Public\LimingZhiyao\model-cache")

    def test_windows_cache_system_drive_fallback_is_absolute(self) -> None:
        self.assertEqual(_windows_model_cache({}), r"C:\ProgramData\LimingZhiyao\model-cache")
        self.assertEqual(
            _windows_model_cache({"SystemDrive": "D:"}),
            r"D:\ProgramData\LimingZhiyao\model-cache",
        )

    def test_paddlex_defaults_can_be_forced_to_bos_before_import(self) -> None:
        previous_source = os.environ.get("PADDLE_PDX_MODEL_SOURCE")
        previous_check = os.environ.get("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK")
        try:
            _configure_paddlex_model_source("BOS")
            self.assertEqual(os.environ["PADDLE_PDX_MODEL_SOURCE"], "bos")
            self.assertEqual(os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"], "True")
        finally:
            if previous_source is None:
                os.environ.pop("PADDLE_PDX_MODEL_SOURCE", None)
            else:
                os.environ["PADDLE_PDX_MODEL_SOURCE"] = previous_source
            if previous_check is None:
                os.environ.pop("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", None)
            else:
                os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = previous_check

    def test_unknown_paddlex_model_source_is_rejected(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "unsupported ANALYZER_PADDLE_MODEL_SOURCE"):
            _configure_paddlex_model_source("random-mirror")

    def test_windows_paddle_runtime_is_pinned_to_the_compatible_release(self) -> None:
        project = Path(__file__).resolve().parents[1] / "pyproject.toml"
        configuration = project.read_text(encoding="utf-8")

        self.assertIn('"paddlepaddle==3.2.0"', configuration)
        self.assertNotIn('"paddlepaddle>=3.2,<4"', configuration)

    def test_empty_json_error_removes_only_known_cache_and_retries(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            damaged = root / "models" / "known-model"
            damaged.mkdir(parents=True)
            (damaged / "configuration.json").write_text("", encoding="utf-8")
            unrelated = root / "models" / "keep-me"
            unrelated.mkdir(parents=True)
            (unrelated / "configuration.json").write_text("{}", encoding="utf-8")
            calls = 0

            def factory() -> object:
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise RuntimeError(
                        "[json.exception.parse_error.101] parse error at line 1, column 1: "
                        "attempting to parse an empty input"
                    )
                return object()

            result = _initialize_model_with_cache_repair(
                "Test model",
                factory,
                root,
                (Path("models/known-model"),),
            )

            self.assertIsNotNone(result)
            self.assertEqual(calls, 2)
            self.assertFalse(damaged.exists())
            self.assertTrue(unrelated.exists())

    def test_unrelated_error_is_labeled_without_deleting_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cached = root / "models" / "known-model"
            cached.mkdir(parents=True)

            with self.assertRaisesRegex(RuntimeError, "Test model model initialization failed"):
                _initialize_model_with_cache_repair(
                    "Test model",
                    lambda: (_ for _ in ()).throw(RuntimeError("unsupported instruction")),
                    root,
                    (Path("models/known-model"),),
                )

            self.assertTrue(cached.exists())

    def test_missing_inference_json_removes_cache_and_retries(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            damaged = root / "official_models" / "PP-OCRv5_mobile_det"
            damaged.mkdir(parents=True)
            (damaged / "config.json").write_text("{}", encoding="utf-8")
            calls = 0

            def factory() -> object:
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise RuntimeError(
                        "(NotFound) Cannot open file cache/PP-OCRv5_mobile_det/inference.json. "
                        "Expected paddle::inference::IsFileExists(prog_file_) == true"
                    )
                return object()

            result = _initialize_model_with_cache_repair(
                "PaddleOCR visual recognition",
                factory,
                root,
                (Path("official_models/PP-OCRv5_mobile_det"),),
            )

            self.assertIsNotNone(result)
            self.assertEqual(calls, 2)
            self.assertFalse(damaged.exists())

    def test_cache_cleanup_refuses_parent_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "cache"
            root.mkdir()
            outside = root.parent / "outside"
            outside.mkdir()

            removed = _remove_cache_entries(root, (Path("../outside"),))

            self.assertEqual(removed, ())
            self.assertTrue(outside.exists())


if __name__ == "__main__":
    unittest.main()
