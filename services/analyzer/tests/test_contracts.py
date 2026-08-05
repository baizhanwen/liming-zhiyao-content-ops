import unittest

from liming_analyzer.contracts import AnalysisJobStatus, AnalysisJobUpdate, can_transition


class ContractTests(unittest.TestCase):
    def test_terminal_job_cannot_restart_without_retry_state(self):
        self.assertFalse(can_transition(AnalysisJobStatus.COMPLETED, AnalysisJobStatus.PENDING))
        self.assertTrue(can_transition(AnalysisJobStatus.FAILED, AnalysisJobStatus.PENDING))

    def test_failed_update_requires_error_code(self):
        with self.assertRaises(ValueError):
            AnalysisJobUpdate(status=AnalysisJobStatus.FAILED, progress=70, stage="转写")

    def test_progress_is_bounded(self):
        with self.assertRaises(ValueError):
            AnalysisJobUpdate(status=AnalysisJobStatus.ANALYZING, progress=101, stage="分析")


if __name__ == "__main__":
    unittest.main()
