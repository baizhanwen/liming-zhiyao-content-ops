import unittest
import json
from pathlib import Path
from types import SimpleNamespace

from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.model_calls import ModelCalls
from liming_analyzer.providers import InstructorStructureAnalyzer, _recover_complete_script_json
from liming_analyzer.adapters import MediaInfo, NormalizedMedia, TranscriptOutput, TranscriptSegment, VisualOutput


class ModelCallTests(unittest.TestCase):
    def setUp(self):
        self.job = ClaimedJob("job", "org", "project", "video", "url", "analyzing", 90, 1, {}, attempt_count=1)

    def test_ownership_failure_prevents_a_paid_call(self):
        operations = []
        def record(*_):
            raise RuntimeError("revoked")
        with self.assertRaisesRegex(RuntimeError, "revoked"):
            ModelCalls(self.job, record).invoke("report", 100, lambda: operations.append(1))
        self.assertEqual(operations, [])

    def test_failed_response_keeps_known_usage_without_retrying(self):
        records, operations = [], []
        def operation():
            operations.append(1)
            error = RuntimeError("invalid JSON containing private prompt")
            error.total_usage = SimpleNamespace(prompt_tokens=12, completion_tokens=8, total_tokens=20)
            raise error
        with self.assertRaises(RuntimeError):
            ModelCalls(self.job, lambda _job, record: records.append(record)).invoke("corrected_original", 100, operation)
        self.assertEqual(operations, [1])
        self.assertEqual([r["status"] for r in records], ["started", "failed"])
        self.assertEqual(records[-1]["totalTokens"], 20)
        self.assertEqual(records[0]["id"], records[1]["id"])
        self.assertNotIn("private prompt", str(records))

    def test_missing_ack_keeps_started_record_without_repeating_external_call(self):
        records, operations = [], []
        def record(_job, value):
            if value["status"] != "started":
                raise ConnectionResetError("lost acknowledgement")
            records.append(value)
            return {"requests": 1, "unknown_usage_requests": 1}
        def operation():
            operations.append(1)
            return "result", None
        calls = ModelCalls(self.job, record)
        self.assertEqual(calls.invoke("report", 100, operation)[0], "result")
        self.assertEqual(operations, [1])
        self.assertEqual(calls.summary["unknown_usage_requests"], 1)

    def test_script_recovery_uses_actual_schema_and_never_accepts_truncated_or_oversized_paragraphs(self):
        analyzer = InstructorStructureAnalyzer(api_key="synthetic-test", base_url="https://example.invalid/v1", model="test", provider="openai")
        def error(raw):
            value = RuntimeError("invalid json")
            value.last_completion = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=raw))])
            return value
        valid = '{"paragraphs":[{"paragraph_id":"p1","text":"完整原文"}]}'
        self.assertEqual(_recover_complete_script_json(error("```json\n" + valid + "\n```"), analyzer.script_rewrite_model)["paragraphs"][0]["text"], "完整原文")
        self.assertIsNone(_recover_complete_script_json(error(valid[:-3]), analyzer.script_rewrite_model))
        import json
        oversized = json.dumps({"paragraphs": [{"paragraph_id": str(i), "text": "完整原文"} for i in range(9)]})
        self.assertIsNone(_recover_complete_script_json(error(oversized), analyzer.script_rewrite_model))

    def test_invalid_or_rate_limited_correction_stops_after_two_rounds_and_preserves_source(self):
        for message in ("invalid JSON for ScriptRewriteBatch", "429 rate limited", "output is incomplete"):
            with self.subTest(message=message):
                calls, records = [], []
                report = {"summary": "来源内容", "hook": "先说问题", "structure": ["问题"], "audience": "管理者", "evidence": [{"start_ms": 0, "text": "先说问题", "source": "asr"}], "confidence": 90}
                def create(**kwargs):
                    calls.append(kwargs)
                    if kwargs["temperature"] == 0.0:
                        error = RuntimeError(message)
                        error.total_usage = SimpleNamespace(prompt_tokens=8, completion_tokens=2, total_tokens=10)
                        raise error
                    return dict(report), SimpleNamespace(usage=SimpleNamespace(prompt_tokens=80, completion_tokens=20, total_tokens=100))
                def recorder(_job, record):
                    records.append(record)
                    return {"requests": sum(r["status"] == "started" for r in records)}
                analyzer = InstructorStructureAnalyzer(api_key="", base_url="https://example.invalid/v1", model="fixture", provider="test", client=SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create_with_completion=create))), report_model=object, generate_script_variants=True, call_recorder=recorder)
                result = analyzer.analyze(self.job, NormalizedMedia(Path("fixture.mp4"), None, MediaInfo(1000, 0, 0, None, "aac")), TranscriptOutput("zh", (TranscriptSegment(0, 1000, "先说问题", 90),)), VisualOutput())
                self.assertEqual(len(calls), 3)
                self.assertTrue(all(call["max_retries"] == 1 for call in calls))
                self.assertEqual(result.report["spoken_script_set"]["corrected_original"]["status"], "failed")
                self.assertEqual(result.report["evidence"][0]["text"], "先说问题")
                self.assertEqual([record["status"] for record in records if record["status"] != "started"], ["completed", "failed", "failed"])
                self.assertEqual(sum(record.get("totalTokens", 0) for record in records), 120)

    def test_truncated_or_oversized_report_has_only_one_continuation_then_traceable_partial_result(self):
        for oversized in (False, True):
            with self.subTest(oversized=oversized):
                calls = []
                raw = '{"summary":"原始摘要","hook":"先说问题","structure":["问题"],"audience":"管理者","evidence":['
                if oversized:
                    raw = json.dumps({"summary": "原始摘要", "hook": "先说问题", "structure": ["问题"], "audience": "管理者", "insight_evidence": [{"section": "hook_analysis", "item_index": 0, "evidence_text": "先说问题"}] * 21})
                def create(**kwargs):
                    calls.append(kwargs)
                    error = RuntimeError("Report insight_evidence too long" if oversized else "invalid JSON")
                    if len(calls) == 1:
                        error.last_completion = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=raw))])
                    raise error
                analyzer = InstructorStructureAnalyzer(api_key="", base_url="https://example.invalid/v1", model="fixture", provider="test", client=SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create_with_completion=create))), report_model=object)
                result = analyzer.analyze(self.job, NormalizedMedia(Path("fixture.mp4"), None, MediaInfo(1000, 0, 0, None, "aac")), TranscriptOutput("zh", (TranscriptSegment(0, 1000, "先说问题", 90),)), VisualOutput())
                self.assertEqual(len(calls), 2)
                self.assertEqual(result.report["evidence"][0]["text"], "先说问题")
                self.assertEqual(result.report["analysis_meta"]["recovered_json_outputs"], 1)
                self.assertTrue(result.report["analysis_meta"]["quality_audit"]["requires_review"])


if __name__ == "__main__":
    unittest.main()
