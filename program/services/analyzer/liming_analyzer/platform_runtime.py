"""Select installation ownership primitives without importing Windows APIs on POSIX."""
import os

if os.name == "nt":
    from .windows_runtime import InstanceAlreadyRunning, InstanceLock, ProcessTree, installation_root, watch_supervisor

    def prepare_processing_child(owner_pid):
        # The Windows owner attaches its Job Object before sending "attached".
        return None
else:
    from .posix_runtime import InstanceAlreadyRunning, InstanceLock, ProcessTree, installation_root, prepare_processing_child, watch_supervisor

__all__ = ["InstanceAlreadyRunning", "InstanceLock", "ProcessTree", "installation_root", "prepare_processing_child", "watch_supervisor"]
