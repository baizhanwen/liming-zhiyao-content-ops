"""Synthetic regression checks for bounded correction retries; no model calls."""
import ast
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import ClassVar

from instructor.core.exceptions import IncompleteOutputException
from openai import LengthFinishReasonError
from test_providers import FakeReport

from liming_analyzer.adapters import (
    MediaInfo,
    NormalizedMedia,
    TranscriptOutput,
    TranscriptSegment,
    VisualOutput,
)
from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.providers import (
    InstructorStructureAnalyzer,
    _generate_corrected_script,
    _is_output_token_limit_error,
)


def length_error(*, mapping=False, completion_attribute="last_completion", output_tokens=800):
    error = RuntimeError("provider response rejected")
    completion = (
        {"choices": [{"finish_reason": "length"}]}
        if mapping
        else SimpleNamespace(
            choices=[SimpleNamespace(finish_reason="length", message=SimpleNamespace(content='{"paragraphs":['))],
            usage=SimpleNamespace(
                prompt_tokens=100, completion_tokens=output_tokens, total_tokens=100 + output_tokens,
            ),
        )
    )
    setattr(error, completion_attribute, completion)
    return error


def complete_response(payload):
    return {
        "paragraphs": [
            {"paragraph_id": item["paragraph_id"], "text": item["text"] + "。"}
            for item in payload["paragraphs"]
        ]
    }


def request_payload(call):
    content = call["messages"][1]["content"]
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        return ast.literal_eval(content)


class CorrectionTokenRetryTests(unittest.TestCase):
    source_rows: ClassVar[list[dict[str, str]]] = [
        {"segment_id": "t-0001", "text": "我们应该先检查数据再决定下一步行动"},
    ]

    def test_length_retry_increases_budget_and_returns_complete_script(self):
        calls = []

        def request(_task, payload, output_tokens):
            calls.append((payload, output_tokens))
            if len(calls) == 1:
                raise length_error()
            return complete_response(payload)

        candidate, error = _generate_corrected_script(self.source_rows, request)

        self.assertEqual(error, "")
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate["source_segment_ids"], ["t-0001"])
        self.assertEqual(candidate["paragraphs"], [self.source_rows[0]["text"] + "。"])
        self.assertEqual(len(calls), 2)
        self.assertEqual([call[0]["attempt"] for call in calls], [1, 2])
        self.assertGreater(calls[1][1], calls[0][1])

    def test_second_length_error_stops_after_two_requests_without_partial_script(self):
        budgets = []

        def request(_task, _payload, output_tokens):
            budgets.append(output_tokens)
            raise length_error()

        candidate, error = _generate_corrected_script(self.source_rows, request)

        self.assertIsNone(candidate)
        self.assertIn("provider response rejected", error)
        self.assertEqual(len(budgets), 2)
        self.assertGreater(budgets[1], budgets[0])

    def test_increased_budget_respects_configured_cap(self):
        budgets = []

        def request(_task, payload, output_tokens):
            budgets.append(output_tokens)
            if len(budgets) == 1:
                raise length_error()
            return complete_response(payload)

        candidate, error = _generate_corrected_script(
            self.source_rows, request, max_output_tokens=1_200,
        )

        self.assertIsNotNone(candidate)
        self.assertEqual(error, "")
        self.assertEqual(budgets, [800, 1_200])

    def test_length_at_configured_cap_does_not_repeat_same_paid_request(self):
        budgets = []

        def request(_task, _payload, output_tokens):
            budgets.append(output_tokens)
            raise length_error()

        candidate, error = _generate_corrected_script(
            self.source_rows, request, max_output_tokens=800,
        )

        self.assertIsNone(candidate)
        self.assertTrue(error)
        self.assertEqual(budgets, [800])

    def test_mapping_validation_retry_keeps_original_budget(self):
        budgets = []

        def request(_task, payload, output_tokens):
            budgets.append(output_tokens)
            return {"paragraphs": []} if len(budgets) == 1 else complete_response(payload)

        candidate, error = _generate_corrected_script(self.source_rows, request)

        self.assertIsNotNone(candidate)
        self.assertEqual(error, "")
        self.assertEqual(budgets, [800, 800])

    def test_other_provider_errors_do_not_increase_budget(self):
        for exception in (
            TimeoutError("request timed out"),
            ValueError("invalid max_tokens parameter"),
            ValueError("JSON validation failed"),
        ):
            with self.subTest(error=str(exception)):
                budgets = []

                def request(_task, payload, output_tokens, _budgets=budgets, _error=exception):
                    _budgets.append(output_tokens)
                    if len(_budgets) == 1:
                        raise _error
                    return complete_response(payload)

                candidate, error = _generate_corrected_script(self.source_rows, request)
                self.assertIsNotNone(candidate)
                self.assertEqual(error, "")
                self.assertEqual(budgets, [800, 800])

    def test_token_limit_detector_accepts_sdk_completion_shapes(self):
        for mapping in (False, True):
            for attribute in ("last_completion", "completion"):
                with self.subTest(mapping=mapping, attribute=attribute):
                    self.assertTrue(_is_output_token_limit_error(
                        length_error(mapping=mapping, completion_attribute=attribute),
                    ))

    def test_token_limit_detector_unwraps_chained_error_without_looping(self):
        original = length_error()
        wrapper = RuntimeError("provider wrapper")
        wrapper.__cause__ = original
        self.assertTrue(_is_output_token_limit_error(wrapper))
        ordinary = ValueError("invalid max_tokens parameter")
        ordinary.__cause__ = ordinary
        self.assertFalse(_is_output_token_limit_error(ordinary))

    def test_token_limit_detector_accepts_installed_sdk_exceptions(self):
        self.assertTrue(_is_output_token_limit_error(IncompleteOutputException(
            message="provider response rejected",
        )))
        completion = SimpleNamespace(usage=None, choices=[SimpleNamespace(finish_reason="length")])
        self.assertTrue(_is_output_token_limit_error(LengthFinishReasonError(completion=completion)))

    def test_only_truncated_batch_receives_larger_budget(self):
        rows = [
            {"segment_id": f"t-{index:04d}", "text": "检查数据并明确目标" * 90}
            for index in range(1, 6)
        ]
        calls = []
        truncated = False

        def request(_task, payload, output_tokens):
            nonlocal truncated
            batch_index = payload["batch"]["index"]
            calls.append((batch_index, output_tokens))
            if batch_index == 2 and not truncated:
                truncated = True
                raise length_error()
            return complete_response(payload)

        candidate, error = _generate_corrected_script(rows, request)

        self.assertIsNotNone(candidate)
        self.assertEqual(error, "")
        self.assertEqual(candidate["source_segment_ids"], [row["segment_id"] for row in rows])
        first_batch_budgets = [budget for index, budget in calls if index == 1]
        second_batch_budgets = [budget for index, budget in calls if index == 2]
        self.assertTrue(first_batch_budgets)
        self.assertEqual(len(set(first_batch_budgets)), 1)
        self.assertEqual(len(second_batch_budgets), 2)
        self.assertGreater(second_batch_budgets[1], second_batch_budgets[0])

    def test_token_limit_detector_rejects_non_length_failures(self):
        for error in (
            TimeoutError("request timed out"),
            ValueError("invalid max_tokens parameter"),
            ValueError("maximum context length exceeded; reduce max_tokens"),
            ValueError("incomplete JSON; expected closing bracket"),
        ):
            with self.subTest(error=str(error)):
                self.assertFalse(_is_output_token_limit_error(error))

    def run_flash_correction(self, max_output_tokens):
        calls = []
        records = []

        def create_with_completion(**kwargs):
            calls.append(kwargs)
            payload = request_payload(kwargs)
            if "paragraphs" not in payload:
                return FakeReport(), SimpleNamespace(usage=None)
            correction_calls = [
                call for call in calls
                if "paragraphs" in request_payload(call)
            ]
            if len(correction_calls) == 1:
                raise length_error(output_tokens=kwargs["max_completion_tokens"])
            return complete_response(payload), SimpleNamespace(usage=None)

        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(
            create_with_completion=create_with_completion,
        )))

        def record_call(_job, record):
            records.append(record)
            return {"requests": sum(item["status"] == "started" for item in records)}

        analyzer = InstructorStructureAnalyzer(
            api_key="", base_url="https://example.invalid/v1", model="MiniMax-M3.1-Flash",
            provider="minimax", client=client, report_model=object,
            generate_script_variants=True, call_recorder=record_call,
            max_output_tokens=max_output_tokens,
        )
        result = analyzer.analyze(
            ClaimedJob("synthetic-job", "synthetic-org", "synthetic-project", "synthetic-video", "upload", "analyzing", 84, 4, {}),
            NormalizedMedia(Path("synthetic.mp4"), None, MediaInfo(6_000, 1080, 1920, "h264", "aac")),
            TranscriptOutput("zh-CN", (TranscriptSegment(100, 900, self.source_rows[0]["text"], 94),), 94),
            VisualOutput(),
        )

        correction_calls = [
            call for call in calls
            if "paragraphs" in request_payload(call)
        ]
        correction_records = [record for record in records if record["task"] == "corrected_original"]
        return result, correction_calls, correction_records

    def test_flash_request_parameters_and_durable_records_use_increased_budget(self):
        result, calls, records = self.run_flash_correction(1_200)
        self.assertEqual([call["max_completion_tokens"] for call in calls], [800, 1_200])
        self.assertTrue(all("max_tokens" not in call for call in calls))
        self.assertEqual([record["status"] for record in records], ["started", "failed", "started", "completed"])
        self.assertEqual([record["outputBudget"] for record in records], [800, 800, 1_200, 1_200])
        self.assertEqual(result.report["spoken_script_set"]["corrected_original"]["status"], "completed")

    def test_flash_request_lower_cap_stops_after_first_truncation(self):
        result, calls, records = self.run_flash_correction(600)
        self.assertEqual([call["max_completion_tokens"] for call in calls], [600])
        self.assertEqual([record["status"] for record in records], ["started", "failed"])
        self.assertEqual([record["outputBudget"] for record in records], [600, 600])
        self.assertEqual(result.report["spoken_script_set"]["corrected_original"]["status"], "failed")
        self.assertEqual(result.report["spoken_script"], [])


if __name__ == "__main__":
    unittest.main()
