from __future__ import annotations

import multiprocessing
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from liming_analyzer.posix_runtime import (
    InstanceAlreadyRunning,
    InstanceLock,
    ProcessTree,
    prepare_processing_child,
)


def _hold_lock(connection, root):
    with InstanceLock(Path(root)):
        connection.send("locked")
        connection.recv()


def _owned_child(connection, owner):
    prepared = prepare_processing_child(owner)
    connection.send(("prepared", prepared))
    if connection.recv() != "attached":
        return
    helper = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(15)"])
    connection.send(("helper", helper.pid))
    command = connection.recv()
    if command == "native":
        # Hold the interpreter GIL inside libc. Only the separate group guard
        # can perform cleanup, regardless of Python thread scheduling.
        import ctypes
        import signal
        signal.alarm(15)
        connection.send("native_ready")
        ctypes.PyDLL(None).pause()
    else:
        time.sleep(15)


def _crashing_owner(connection):
    context = multiprocessing.get_context("spawn")
    owner, child = context.Pipe()
    process = context.Process(target=_owned_child, args=(child, os.getpid()))
    process.start()
    child.close()
    kind, prepared = owner.recv()
    if kind != "prepared":
        return
    tree = ProcessTree()
    tree.attach(process.pid, prepared)
    owner.send("attached")
    _, helper = owner.recv()
    owner.send("wait")
    connection.send((process.pid, helper))
    # The outer test kills this exact multiprocessing owner instance. Abrupt
    # exit closes its capability; no normal finally block is involved.
    time.sleep(15)


def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    if sys.platform.startswith("linux"):
        try:
            return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"
        except FileNotFoundError:
            return False
    result = subprocess.run(["/bin/ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True, timeout=1, check=False)
    return result.returncode == 0 and not result.stdout.strip().startswith("Z")


@unittest.skipUnless(os.name == "posix", "POSIX analyzer ownership")
class PosixRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.context = multiprocessing.get_context("spawn")
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def start_child(self):
        owner, child = self.context.Pipe()
        process = self.context.Process(target=_owned_child, args=(child, os.getpid()))
        tree = ProcessTree()
        process.start()
        child.close()

        def cleanup():
            tree.close()
            process.join(3)
            if process.is_alive():
                process.kill()
                process.join(2)
            owner.close()
            process.close()

        self.addCleanup(cleanup)
        self.assertTrue(owner.poll(8), "processing preparation timed out")
        kind, prepared = owner.recv()
        self.assertEqual(kind, "prepared")
        self.assertEqual(prepared["pgid"], process.pid)
        tree.attach(process.pid, prepared)
        owner.send("attached")
        self.assertTrue(owner.poll(5))
        kind, helper = owner.recv()
        self.assertEqual(kind, "helper")
        return process, tree, owner, helper

    def assert_stopped(self, *pids):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and any(_alive(pid) for pid in pids):
            time.sleep(0.03)
        self.assertFalse(any(_alive(pid) for pid in pids), "owned processing group did not stop")

    def test_lock_scopes_by_project_and_purpose_and_has_bounded_wait(self):
        with InstanceLock(self.root):
            started = time.monotonic()
            with self.assertRaises(InstanceAlreadyRunning):
                InstanceLock(self.root, wait_ms=60)
            self.assertLess(time.monotonic() - started, 0.5)
            with InstanceLock(self.root, "processing"), InstanceLock(self.root / "independent"):
                pass
        with InstanceLock(self.root):
            pass

    def test_abrupt_owner_exit_releases_flock_without_deleting_lock_files(self):
        owner, child = self.context.Pipe()
        process = self.context.Process(target=_hold_lock, args=(child, str(self.root)))
        process.start()
        child.close()
        try:
            self.assertTrue(owner.poll(5))
            self.assertEqual(owner.recv(), "locked")
            with self.assertRaises(InstanceAlreadyRunning):
                InstanceLock(self.root)
            process.terminate()
            process.join(3)
            with InstanceLock(self.root, wait_ms=200):
                pass
            self.assertTrue((self.root / ".local/analyzer-locks/worker.lock").is_file())
        finally:
            if process.is_alive():
                process.kill()
                process.join(2)
            process.close()
            owner.close()

    def test_close_stops_child_and_its_same_group_native_helper(self):
        process, tree, owner, helper = self.start_child()
        owner.send("wait")
        tree.close()
        tree.close()
        process.join(3)
        self.assert_stopped(process.pid, helper)

    def test_external_guard_stops_a_model_that_holds_the_python_gil(self):
        process, tree, owner, helper = self.start_child()
        owner.send("native")
        self.assertTrue(owner.poll(3))
        self.assertEqual(owner.recv(), "native_ready")
        time.sleep(0.05)
        tree.close()
        process.join(3)
        self.assert_stopped(process.pid, helper)

    def test_owner_crash_releases_the_group_through_control_eof(self):
        owner, child = self.context.Pipe()
        process = self.context.Process(target=_crashing_owner, args=(child,))
        process.start()
        child.close()
        try:
            self.assertTrue(owner.poll(8))
            processing, helper = owner.recv()
            process.kill()
            process.join(3)
            self.assert_stopped(processing, helper)
        finally:
            if process.is_alive():
                process.kill()
                process.join(2)
            process.close()
            owner.close()

    def test_no_cached_pid_can_attach_without_a_private_capability(self):
        with ProcessTree() as tree:
            with self.assertRaises(RuntimeError):
                tree.attach(os.getpid())
            with self.assertRaises(RuntimeError):
                tree.attach(os.getpid(), {"pid": os.getpid(), "pgid": os.getpid(), "ownerPid": os.getpid(), "control": None})
        for purpose in ("../other", "worker/other", ""):
            with self.assertRaises(ValueError):
                InstanceLock(self.root, purpose)
        for wait in (-1, 60_001, True):
            with self.assertRaises(ValueError):
                InstanceLock(self.root, wait_ms=wait)


if __name__ == "__main__":
    unittest.main()
