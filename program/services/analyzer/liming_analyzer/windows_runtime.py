"""Windows ownership primitives for the local analyzer (no PID-based killing)."""
from __future__ import annotations

import ctypes
import hashlib
import os
import threading
from ctypes import wintypes
from pathlib import Path


class InstanceAlreadyRunning(RuntimeError):
    pass


class _ProcessEntry(ctypes.Structure):
    _fields_ = [
        ("size", wintypes.DWORD), ("usage", wintypes.DWORD), ("pid", wintypes.DWORD),
        ("heap", ctypes.c_size_t), ("module", wintypes.DWORD), ("threads", wintypes.DWORD),
        ("parent", wintypes.DWORD), ("priority", wintypes.LONG), ("flags", wintypes.DWORD),
        ("name", wintypes.WCHAR * 260),
    ]


def installation_root() -> Path:
    return Path(__file__).resolve().parents[3]


def mutex_name(root: Path, purpose: str) -> str:
    canonical = str(root.resolve()).rstrip("\\/").upper()
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"Global\\LimingZhiyao-{purpose}-{digest}"


def _kernel():
    if os.name != "nt":
        raise RuntimeError("The local video analyzer requires Windows.")
    dll = ctypes.WinDLL("kernel32", use_last_error=True)
    signatures = {
        "CreateMutexW": ([ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR], wintypes.HANDLE),
        "WaitForSingleObject": ([wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
        "ReleaseMutex": ([wintypes.HANDLE], wintypes.BOOL),
        "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
        "CreateJobObjectW": ([ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
        "SetInformationJobObject": ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
        "OpenProcess": ([wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
        "AssignProcessToJobObject": ([wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
        "TerminateJobObject": ([wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
        "CreateToolhelp32Snapshot": ([wintypes.DWORD, wintypes.DWORD], wintypes.HANDLE),
        "Process32FirstW": ([wintypes.HANDLE, ctypes.POINTER(_ProcessEntry)], wintypes.BOOL),
        "Process32NextW": ([wintypes.HANDLE, ctypes.POINTER(_ProcessEntry)], wintypes.BOOL),
        "GetProcessTimes": ([wintypes.HANDLE, *([ctypes.POINTER(wintypes.FILETIME)] * 4)], wintypes.BOOL),
    }
    for name, (arguments, result) in signatures.items():
        function = getattr(dll, name)
        function.argtypes = arguments
        function.restype = result
    return dll


def _process_parent(kernel, pid):
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        entry = _ProcessEntry()
        entry.size = ctypes.sizeof(entry)
        found = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while found:
            if entry.pid == pid:
                return entry.parent, entry.name.lower()
            found = kernel.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    return None, ""


def _creation_time(kernel, handle):
    values = [wintypes.FILETIME() for _ in range(4)]
    if not kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in values)):
        raise ctypes.WinError(ctypes.get_last_error())
    return values[0].dwHighDateTime << 32 | values[0].dwLowDateTime


def watch_supervisor():
    """Watch a handle to the actual launching parent, never a reused PID."""
    configured = os.environ.get("ANALYZER_SUPERVISOR_PID", "")
    if not configured:
        return
    if not configured.isdigit():
        raise RuntimeError("Analyzer supervisor identity is invalid")
    kernel = _kernel()
    handle = kernel.OpenProcess(0x00100000 | 0x1000, False, int(configured))  # SYNCHRONIZE + limited query
    if not handle:
        raise RuntimeError("Analyzer supervisor has already exited")
    try:
        parent = os.getppid()
        if int(configured) != parent:
            # Windows venv python.exe redirects to the base interpreter using
            # one additional Python process. Verify that precise relationship.
            ancestor, executable = _process_parent(kernel, parent)
            if ancestor != int(configured) or executable not in {"python.exe", "pythonw.exe"}:
                raise RuntimeError("Analyzer supervisor identity does not match its launch chain")
        # If an exited ancestor's PID was reused, the replacement was created
        # after this worker. Keep a handle to the verified original identity.
        if _creation_time(kernel, handle) > _creation_time(kernel, ctypes.c_void_p(-1)):
            raise RuntimeError("Analyzer supervisor PID was reused")
    except BaseException:
        kernel.CloseHandle(handle)
        raise
    def wait_for_exit():
        try:
            result = kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
            if result == 0:
                # Abrupt exit closes this owner's job handles and kills its
                # processing tree, including a native call that never returns.
                os._exit(23)
        finally:
            kernel.CloseHandle(handle)
    threading.Thread(target=wait_for_exit, daemon=True, name="analyzer-supervisor-watch").start()


class InstanceLock:
    """An abandoned owner releases ownership automatically, even across sessions."""

    def __init__(self, root: Path, purpose: str = "worker", wait_ms: int = 0):
        self.kernel = _kernel()
        self.handle = self.kernel.CreateMutexW(None, False, mutex_name(root, purpose))
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        result = self.kernel.WaitForSingleObject(self.handle, wait_ms)
        if result not in {0, 0x80}:  # acquired or abandoned
            self.kernel.CloseHandle(self.handle)
            self.handle = None
            if result == 0x102:
                raise InstanceAlreadyRunning("This installation already has an active analyzer.")
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self):
        if self.handle:
            self.kernel.ReleaseMutex(self.handle)
            self.kernel.CloseHandle(self.handle)
            self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class _BasicLimits(ctypes.Structure):
    _fields_ = [
        ("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong),
        ("flags", wintypes.DWORD), ("min_working_set", ctypes.c_size_t),
        ("max_working_set", ctypes.c_size_t), ("active_processes", wintypes.DWORD),
        ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD),
    ]


class _IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in (
        "read_operations", "write_operations", "other_operations", "read_bytes", "write_bytes", "other_bytes",
    )]


class _ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("basic", _BasicLimits), ("io", _IoCounters),
        ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
        ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t),
    ]


class ProcessTree:
    """The parent alone holds this handle: parent death kills the attached tree.

    Attach a newly spawned child BEFORE sending its first work command. Child
    processes (FFmpeg, vision helpers) inherit the job; breakaway is not enabled.
    """

    def __init__(self):
        self.kernel = _kernel()
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = _ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            code = ctypes.get_last_error()
            self.close()
            raise ctypes.WinError(code)

    def attach(self, pid: int):
        process = self.kernel.OpenProcess(0x0100 | 0x0001, False, pid)
        if not process:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            if not self.kernel.AssignProcessToJobObject(self.handle, process):
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            self.kernel.CloseHandle(process)

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()
