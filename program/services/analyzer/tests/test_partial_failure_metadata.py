"""Classified request failures must remain readable partial-report metadata."""

import unittest

from test_content_analysis import synthetic_inputs

from liming_analyzer.content_analysis import build_content_analysis
from liming_analyzer.unified_analysis import UnifiedRequestError


class PartialFailureMetadataTests(unittest.TestCase):
    def test_empty_sdk_issue_lists_retain_each_classified_failure_code(self):
        for reason in ("length", "timeout", "overloaded", "provider_error", "schema_invalid",
                       "evidence_invalid", "input_budget", "canonical_failed", "not_requested",
                       "upstream_module_failed"):
            with self.subTest(reason=reason):
                def request(*_args, reason=reason):
                    # This constructor supplies [] when no schema-specific
                    # issues exist, including normal provider/length failures.
                    raise UnifiedRequestError({"failure_kind": reason})

                result = build_content_analysis(*synthetic_inputs(), request, _compact_payload=True)
                self.assertEqual(result["status"], "partial")
                failed = {key: state for key, state in result["module_status"].items() if state["status"] == "failed"}
                self.assertTrue(failed)
                for key, state in failed.items():
                    self.assertEqual(state["reason"], reason)
                    self.assertEqual(state["validation"], {"passed": False, "issues": [reason]})
                    self.assertIn(f"{key}:{reason}", result["validation"]["issues"])

    def test_existing_safe_issue_codes_are_preserved_and_unsafe_details_are_not_guessed(self):
        for supplied, expected in (
            (["sdk_schema_invalid", "compact_evidence_index"], ["sdk_schema_invalid", "compact_evidence_index"]),
            (["https://private.invalid/?token=do-not-export"], ["provider_error"]),
        ):
            with self.subTest(supplied_count=len(supplied)):
                def request(*_args, supplied=supplied):
                    raise UnifiedRequestError({"failure_kind": "provider_error"}, safe_validation_issues=supplied)

                result = build_content_analysis(*synthetic_inputs(), request, _compact_payload=True)
                for state in result["module_status"].values():
                    if state["status"] == "failed":
                        self.assertEqual(state["validation"], {"passed": False, "issues": expected})
                self.assertNotIn("do-not-export", str(result["validation"]))

    def test_unclassified_or_unsafe_failure_reason_uses_only_the_existing_generic_code(self):
        def request(*_args):
            error = RuntimeError("private provider exception text")
            error.safe_failure_kind = "https://private.invalid/?token=secret"
            error.safe_validation_issues = []
            raise error

        result = build_content_analysis(*synthetic_inputs(), request, _compact_payload=True)
        for state in result["module_status"].values():
            if state["status"] == "failed":
                self.assertEqual(state["reason"], "classification_request_failed")
                self.assertEqual(state["validation"], {"passed": False, "issues": ["classification_request_failed"]})
        self.assertNotIn("secret", str(result["validation"]))


if __name__ == "__main__":
    unittest.main()
