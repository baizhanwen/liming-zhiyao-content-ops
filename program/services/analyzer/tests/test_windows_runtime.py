import ctypes
import multiprocessing
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from liming_analyzer.windows_runtime import InstanceAlreadyRunning, InstanceLock, ProcessTree, _kernel, watch_supervisor


def hold_lock(root, connection):
    try:
        with InstanceLock(Path(root)):
            connection.send("acquired")
            connection.recv()
    except InstanceAlreadyRunning:
        connection.send("busy")


def spawn_grandchild(connection):
    connection.recv()  # The parent must attach the job object first.
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"], creationflags=0x08000000)
    connection.send((os.getpid(), child.pid))
    time.sleep(120)


def own_process_tree(connection):
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe()
    with ProcessTree() as tree:
        process = context.Process(target=spawn_grandchild, args=(child,))
        process.start()
        tree.attach(process.pid)
        parent.send("start")
        connection.send(parent.recv())
        connection.recv()
    process.join(5)


def supervised_worker(connection):
    os.environ["ANALYZER_SUPERVISOR_PID"] = str(os.getppid())
    watch_supervisor()
    own_process_tree(connection)


def fake_supervisor(connection):
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe()
    worker = context.Process(target=supervised_worker, args=(child,))
    worker.start()
    connection.send((worker.pid, *parent.recv()))
    connection.recv()


@unittest.skipUnless(os.name == "nt", "Windows runtime")
class WindowsRuntimeTests(unittest.TestCase):
    def start(self, target, *args):
        context = multiprocessing.get_context("spawn")
        parent, child = context.Pipe()
        process = context.Process(target=target, args=(*args, child))
        process.start()
        child.close()
        self.addCleanup(parent.close)
        def cleanup():
            if process.is_alive():
                process.terminate()
            process.join(5)
            process.close()
        self.addCleanup(cleanup)
        self.assertTrue(parent.poll(15), "child did not become ready")
        return process, parent

    def test_same_installation_rejected_and_abandoned_owner_recovers(self):
        with tempfile.TemporaryDirectory() as root:
            first, first_pipe = self.start(hold_lock, root)
            self.assertEqual(first_pipe.recv(), "acquired")
            second, second_pipe = self.start(hold_lock, root.upper())
            self.assertEqual(second_pipe.recv(), "busy")
            second.join(5)
            first.terminate()
            first.join(5)
            with InstanceLock(Path(root)):
                pass

    def test_other_installation_is_independent(self):
        with tempfile.TemporaryDirectory() as root:
            first, first_pipe = self.start(hold_lock, root)
            self.assertEqual(first_pipe.recv(), "acquired")
            with InstanceLock(Path(root) / "other"):
                pass
            first_pipe.send("stop")
            first.join(5)

    def test_powershell_and_python_use_the_same_installation_mutex(self):
        with tempfile.TemporaryDirectory() as root:
            script = Path(root) / "probe.ps1"
            script.write_text('param($Helper, $Root)\n. $Helper\n$lock = Enter-AnalyzerInstanceLock $Root "worker"\nif ($null -eq $lock) { Write-Output "busy" } else { Exit-AnalyzerInstanceLock $lock; Write-Output "acquired" }\n', encoding="utf-8")
            helper = Path(__file__).resolve().parents[3] / "scripts" / "analyzer-instance-lock.ps1"
            with InstanceLock(Path(root)):
                result = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), str(helper), root], capture_output=True, timeout=15, creationflags=0x08000000)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(b"busy", result.stdout)

    def test_supervisor_crash_terminates_worker_and_its_processing_tree(self):
        supervisor, connection = self.start(fake_supervisor)
        descendants = connection.recv()
        kernel = _kernel()
        handles = [kernel.OpenProcess(0x00100000, False, pid) for pid in descendants]
        self.assertTrue(all(handles))
        try:
            supervisor.terminate()
            supervisor.join(5)
            for handle in handles:
                self.assertEqual(kernel.WaitForSingleObject(handle, 5000), 0, "descendant survived supervisor exit")
        finally:
            for handle in handles:
                if handle:
                    kernel.CloseHandle(handle)

    def test_parent_crash_terminates_child_and_grandchild(self):
        parent, connection = self.start(own_process_tree)
        children = connection.recv()
        kernel = _kernel()
        handles = [kernel.OpenProcess(0x00100000, False, pid) for pid in children]
        self.assertTrue(all(handles))
        try:
            parent.terminate()
            parent.join(5)
            for handle in handles:
                self.assertEqual(kernel.WaitForSingleObject(handle, 5000), 0, "orphaned analyzer child survived its owner")
        finally:
            for handle in handles:
                if handle:
                    kernel.CloseHandle(handle)


if __name__ == "__main__":
    unittest.main()
