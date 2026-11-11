from dataclasses import replace
from unittest.mock import Mock

import pytest

from liming_analyzer.adapters import MediaInfo, NormalizedMedia, TranscriptOutput, TranscriptSegment
from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.pipeline import AnalysisPipeline


def pipeline_and_job(*, standalone):
    source = Mock()

    def acquire(job, path):
        path.write_bytes(b"source")
        return path

    source.acquire.side_effect = acquire
    media = Mock()
    media.prepare.side_effect = lambda path, directory: NormalizedMedia(path, path, MediaInfo(3900, 800, 600, "h264", "aac"))
    speech = Mock()
    speech.transcribe.return_value = TranscriptOutput("zh", (TranscriptSegment(10, 3800, "请听这一句。"),))
    artifacts = Mock()
    visual = Mock()
    visual.analyze.side_effect = RuntimeError("visual service failed")
    job = ClaimedJob("job", "org", "project", "video", "upload", "queued", 1, 0, {"transcript_only": standalone})
    pipeline = AnalysisPipeline(source, media, speech, visual, Mock(), artifacts, manuscript_ocr=Mock())
    return pipeline, job, lambda status, progress, stage: replace(job, status=status, progress=progress)


def test_standalone_preserves_raw_audio_if_optional_caption_reader_fails(monkeypatch):
    def broken_ocr(*args, **kwargs):
        raise RuntimeError("unreadable frame")
    monkeypatch.setattr("liming_analyzer.subtitle_evidence.recover_burned_subtitles", broken_ocr)
    pipeline, job, heartbeat = pipeline_and_job(standalone=True)
    result = pipeline.process(job, heartbeat)
    assert result.transcript.full_text == "请听这一句。"
    assert result.schema_version == "transcript.v1"
    pipeline.artifacts.persist_manuscript.assert_called_once()
    pipeline.visual.analyze.assert_not_called()
    pipeline.structure.analyze.assert_not_called()


def test_full_run_saves_manuscript_before_later_visual_failure():
    pipeline, job, heartbeat = pipeline_and_job(standalone=False)
    with pytest.raises(RuntimeError, match="visual service failed"):
        pipeline.process(job, heartbeat)
    pipeline.speech.transcribe.assert_called_once()
    pipeline.artifacts.persist_manuscript.assert_called_once()
    transcript = pipeline.artifacts.persist_manuscript.call_args.args[1]
    assert transcript.full_text == "请听这一句。"


def test_no_speech_does_not_create_empty_success():
    pipeline, job, heartbeat = pipeline_and_job(standalone=True)
    pipeline.speech.transcribe.return_value = TranscriptOutput("zh", ())
    with pytest.raises(RuntimeError, match="没有识别到"):
        pipeline.process(job, heartbeat)
    pipeline.artifacts.persist_manuscript.assert_not_called()


def test_long_manuscript_keeps_all_words_and_lossless_frame_evidence_on_retry(tmp_path, monkeypatch):
    import base64
    import gzip
    import json

    import liming_analyzer.artifacts as module

    client = Mock()
    store = module.ApiArtifactStore(client)
    transcript = TranscriptOutput("zh", (TranscriptSegment(0, 1600, "评论区回复资料，打包带走。"),))
    frames = [400, 550, 700, 900, 1140, 1360] * 1800
    proof = {"transcript:0001": {"method": "burned_subtitle", "source_text": "评论区回复资料，打包袋子。",
                                 "text": transcript.full_text, "full_caption_match": True,
                                 "timestamps_ms": frames, "captions": [{"text": "打包带走", "timestamps_ms": frames}]}}
    monkeypatch.setattr(module, "_MANUSCRIPT_MAX_BYTES", 4096)
    store.persist_manuscript(Mock(), transcript, tmp_path, proof, manual=False)
    data = (tmp_path / "manuscript.json").read_bytes()
    assert len(data) <= 4096
    parsed = json.loads(data)
    assert parsed["segments"][0]["text"] == transcript.full_text
    assert parsed["subtitle_evidence"]["transcript:0001"]["source_text"] == proof["transcript:0001"]["source_text"]
    assert json.loads(gzip.decompress(base64.b64decode(parsed["subtitle_evidence_archive"]["data"]))) == proof
    store.persist_manuscript(Mock(), transcript, tmp_path, proof, manual=False)
    assert (tmp_path / "manuscript.json").read_bytes() == data


def test_oversized_manuscript_never_uploads_truncated_words(tmp_path, monkeypatch):
    import liming_analyzer.artifacts as module

    monkeypatch.setattr(module, "_MANUSCRIPT_MAX_BYTES", 512)
    client = Mock()
    transcript = TranscriptOutput("zh", (TranscriptSegment(0, 2000, "完整听写。" * 200),))
    with pytest.raises(ValueError, match="无损压缩后仍超过"):
        module.ApiArtifactStore(client).persist_manuscript(Mock(), transcript, tmp_path, {}, manual=False)
    client.upload_artifact.assert_not_called()
