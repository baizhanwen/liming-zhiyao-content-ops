"""Run the same bounded analyzer execution contract on macOS and Linux."""
import os

import test_process_runtime as contract


class PosixProcessRuntimeTests(contract.ProcessRuntimeTests):
    # The base suite is Windows-only. Reuse its real process tests without
    # importing or weakening the Windows ownership implementation.
    __unittest_skip__ = os.name == "nt"
    __unittest_skip_why__ = "POSIX process isolation"
