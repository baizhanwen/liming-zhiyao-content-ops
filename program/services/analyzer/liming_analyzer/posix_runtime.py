"""Project-local POSIX locks and capability-owned processing groups.

The processing child prepares a fresh session before doing any work. Its guard
is a separate interpreter, so a native model holding the GIL cannot block group
cleanup. Only a private control descriptor crosses the prepared handshake; no
cached PID is used to signal an unrelated process. Explicitly detached helper
sessions are outside this process-group boundary.
"""
from __future__ import annotations

import errno
import os
import re
import select
import subprocess
import sys
import threading
import time
from multiprocessing.reduction import DupFd
from pathlib import Path


class InstanceAlreadyRunning(RuntimeError):
    pass


def installation_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _require_posix():
    if os.name != "posix":
        raise RuntimeError("POSIX analyzer ownership is unavailable on this platform")


class InstanceLock:
    """Kernel ownership releases automatically on exit; lock files are not PIDs."""

    def __init__(self, root: Path, purpose: str = "worker", wait_ms: int = 0):
        _require_posix()
        import fcntl

        self.fd = None
        if not isinstance(purpose, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,47}", purpose):
            raise ValueError("Invalid analyzer lock purpose")
        if type(wait_ms) is not int or not 0 <= wait_ms <= 60_000:
            raise ValueError("Analyzer lock wait must be between 0 and 60000 milliseconds")
        directory = Path(root).resolve() / ".local" / "analyzer-locks"
        directory.mkdir(parents=True, exist_ok=True)
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(directory / f"{purpose}.lock", flags, 0o600)
        os.set_inheritable(fd, False)
        deadline = time.monotonic() + wait_ms / 1000
        try:
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.fd = fd
                    return
                except OSError as error:
                    if error.errno not in {errno.EACCES, errno.EAGAIN}:
                        raise
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise InstanceAlreadyRunning("This installation already has an active analyzer.") from None
                    time.sleep(min(0.025, remaining))
        except BaseException:
            os.close(fd)
            raise

    def close(self):
        if self.fd is not None:
            fd, self.fd = self.fd, None
            os.close(fd)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


def watch_supervisor():
    """A live parent relationship cannot be reassigned to a reused parent PID."""
    _require_posix()
    configured = os.environ.get("ANALYZER_SUPERVISOR_PID", "")
    if not configured:
        return
    if not configured.isdigit() or int(configured) <= 1 or os.getppid() != int(configured):
        raise RuntimeError("Analyzer supervisor identity does not match its launching parent")
    parent = int(configured)

    def watch():
        while os.getppid() == parent:
            time.sleep(0.2)
        # Closing the owner's control handles wakes its processing guard.
        os._exit(23)

    threading.Thread(target=watch, daemon=True, name="analyzer-supervisor-watch").start()


_GUARD_SCRIPT = r'''
import os, select, signal, subprocess, sys
child, owner = int(sys.argv[1]), int(sys.argv[2])
if os.getpgrp() != child or os.getsid(0) != child or os.getppid() != child:
    raise SystemExit(24)

def owner_is_parent():
    # This also covers owner death before the descriptor handshake finishes.
    # The guard only signals its own group, regardless of what a PID lookup says.
    try:
        if sys.platform.startswith("linux"):
            with open("/proc/%d/stat" % child, encoding="ascii") as source:
                fields = source.read().rsplit(")", 1)[1].split()
            return int(fields[1]) == owner
        result = subprocess.run(["/bin/ps", "-o", "ppid=", "-p", str(child)],
            capture_output=True, text=True, timeout=1, check=False)
        return result.returncode == 0 and result.stdout.strip() == str(owner)
    except (OSError, ValueError, subprocess.SubprocessError):
        return False

os.write(1, b"ready\n")
os.close(1)
while True:
    readable, _, _ = select.select([0], [], [], 0.2)
    if readable or os.getppid() != child or not owner_is_parent():
        # We are a member of precisely this freshly prepared group. Never signal
        # a stored PID, another installation, or a separately detached session.
        os.killpg(os.getpgrp(), signal.SIGKILL)
'''


def prepare_processing_child(owner_pid: int):
    """Return transferable ownership before sending the child's 'prepared' IPC.

    The owner must call ProcessTree.attach(pid, payload), then acknowledge
    'attached'. The child must not load models or launch media before that ack.
    DupFd's temporary sender copy closes when the owner detaches it; the child
    and guard never retain another writer after the transfer.
    """
    _require_posix()
    if type(owner_pid) is not int or owner_pid <= 1 or os.getppid() != owner_pid:
        raise RuntimeError("Analyzer processing owner no longer matches its parent")
    child = os.getpid()
    if os.getsid(0) != child:
        os.setsid()
    if os.getpgrp() != child or os.getsid(0) != child:
        raise RuntimeError("Analyzer processing session could not be isolated")
    reader, writer = os.pipe()
    guard = None
    try:
        guard = subprocess.Popen(
            [sys.executable, "-c", _GUARD_SCRIPT, str(child), str(owner_pid)],
            stdin=reader, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            close_fds=True,
        )
        os.close(reader)
        reader = None
        if not select.select([guard.stdout], [], [], 5)[0] or guard.stdout.readline(16) != b"ready\n":
            raise RuntimeError("Analyzer processing guard did not become ready")
        guard.stdout.close()
        transferable = DupFd(writer)
        # Only DupFd's one-shot transfer service owns the writer until attach;
        # it closes that copy immediately after passing it to the owner.
        return {"pid": child, "pgid": child, "ownerPid": owner_pid, "control": transferable}
    finally:
        if reader is not None:
            os.close(reader)
        os.close(writer)


class ProcessTree:
    """Close a private guard capability, never kill through a stale cached PID."""

    def __init__(self):
        _require_posix()
        self.fd = None

    @property
    def attached(self):
        return self.fd is not None

    def attach(self, pid: int, prepared=None):
        if self.fd is not None:
            raise RuntimeError("Analyzer process group already has an owner")
        if not isinstance(prepared, dict) or prepared.get("pid") != pid or prepared.get("pgid") != pid or prepared.get("ownerPid") != os.getpid():
            raise RuntimeError("Analyzer processing group requires its private prepared handshake")
        capability = prepared.get("control")
        if not callable(getattr(capability, "detach", None)):
            raise RuntimeError("Analyzer processing control handle is invalid")
        fd = capability.detach()
        try:
            os.set_inheritable(fd, False)
        except BaseException:
            os.close(fd)
            raise
        self.fd = fd

    def close(self):
        if self.fd is not None:
            fd, self.fd = self.fd, None
            try:
                os.write(fd, b"stop")
            except (BrokenPipeError, OSError):
                pass
            finally:
                os.close(fd)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()
