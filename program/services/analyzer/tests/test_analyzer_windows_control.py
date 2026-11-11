"""Synthetic bridge/controller boundary checks; no service or model is started."""
import json
import os
from types import SimpleNamespace

from test_analyzer_local_runtime import isolate, runtime_module


def windows_os(monkeypatch, module):
    values = dict(vars(os), name="nt")
    values["kill"] = lambda *_args: (_ for _ in ()).throw(AssertionError("Windows status must never signal a PID"))
    monkeypatch.setattr(module, "os", SimpleNamespace(**values))


def test_windows_control_routes_to_project_controller_and_actual_web_url(tmp_path, monkeypatch):
    module = runtime_module()
    installation = tmp_path / "中文 安装目录"
    isolate(module, installation, monkeypatch)
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0, stdout=json.dumps({"workerRunning": True, "processRunning": True, "pid": 71, "message": "中文服务已就绪"}, ensure_ascii=False))

    monkeypatch.setattr(module.subprocess, "run", run)
    code, state = module.windows_control("start", "http://127.0.0.1:3100")
    assert code == 0 and state["pid"] == 71
    assert state["message"] == "中文服务已就绪"
    command, options = calls[0]
    assert command == ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
                       str(installation / "scripts/analyzer-windows-control.ps1"), "-Action", "start", "-BaseUrl", "http://127.0.0.1:3100"]
    assert options["cwd"] == installation and options["encoding"] == "utf-8-sig"
    assert options["timeout"] <= 90


def test_controller_failure_is_not_turned_into_success_or_model_configuration_error(monkeypatch):
    module = runtime_module()
    expected = {"workerRunning": False, "processRunning": True, "message": "已启动，等待有效心跳"}
    monkeypatch.setattr(module.subprocess, "run", lambda *_args, **_kwargs: SimpleNamespace(returncode=1, stdout=json.dumps(expected)))
    assert module.windows_control("start") == (1, expected)
    monkeypatch.setattr(module.subprocess, "run", lambda *_args, **_kwargs: SimpleNamespace(returncode=0, stdout="not a control result"))
    code, result = module.windows_control("status")
    assert code == 1 and result["workerRunning"] is False
    assert "模型配置" not in result["message"]


def test_windows_active_process_uses_controller_and_never_os_kill(monkeypatch):
    module = runtime_module()
    windows_os(monkeypatch, module)
    monkeypatch.setattr(module, "windows_control", lambda action: (0, {"processRunning": True, "workerRunning": False, "pid": 92}))
    assert module.active_process() == {"pid": 92}
    monkeypatch.setattr(module, "windows_control", lambda action: (0, {"processRunning": False, "workerRunning": False}))
    assert module.active_process() is None


def test_windows_readiness_preserves_dependency_checks_and_restart_signal(tmp_path, monkeypatch):
    module = runtime_module()
    isolate(module, tmp_path, monkeypatch)
    windows_os(monkeypatch, module)
    calls = []

    def control(action, base_url=None):
        calls.append((action, base_url))
        return 0, {"workerRunning": True, "processRunning": True, "restartRequired": True, "pid": 93, "message": "源码更新，请在空闲时停止并重启。"}

    monkeypatch.setattr(module, "windows_control", control)
    monkeypatch.setattr(module, "resolve_media_tools", lambda *_args: {"ffmpeg": None, "ffprobe": None})
    result = module.readiness_snapshot("http://127.0.0.1:3200")
    assert calls == [("status", "http://127.0.0.1:3200")]
    assert result["workerRunning"] and result["restartRequired"] and result["processRunning"]
    assert not result["ready"] and result["checks"] and result["missing"]
    assert "源码更新" in result["message"] and "仍需准备" in result["message"]


def test_windows_start_adopts_existing_supervisor_without_spawning_direct_worker(monkeypatch, capsys):
    module = runtime_module()
    windows_os(monkeypatch, module)
    monkeypatch.setattr(module.sys, "argv", ["runtime", "start", "--base-url", "http://127.0.0.1:5173"])
    monkeypatch.setattr(module, "readiness_snapshot", lambda *_args: {"ready": True, "workerRunning": False, "checks": [{"id": "fixture"}]})
    calls = []

    def control(action, base_url=None):
        calls.append((action, base_url))
        return 0, {"workerRunning": True, "processRunning": True, "alreadyRunning": True, "pid": 94}

    monkeypatch.setattr(module, "windows_control", control)
    monkeypatch.setattr(module.subprocess, "Popen", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("No direct Windows worker launch")))
    assert module.main() == 0
    assert calls == [("start", "http://127.0.0.1:5173")]
    state = json.loads(capsys.readouterr().out)
    assert state["workerRunning"] and state["alreadyRunning"] and state["checks"]


def test_windows_stop_propagates_incomplete_stop_instead_of_claiming_success(monkeypatch, capsys):
    module = runtime_module()
    windows_os(monkeypatch, module)
    monkeypatch.setattr(module.sys, "argv", ["runtime", "stop", "--base-url", "http://127.0.0.1:3100"])
    monkeypatch.setattr(module, "readiness_snapshot", lambda *_args: {"ready": True, "workerRunning": True, "checks": []})
    calls = []

    def control(action, base_url=None):
        calls.append((action, base_url))
        return 1, {"workerRunning": False, "processRunning": True, "message": "进程仍在退出"}

    monkeypatch.setattr(module, "windows_control", control)
    assert module.main() == 1
    assert calls == [("stop", "http://127.0.0.1:3100")]
    state = json.loads(capsys.readouterr().out)
    assert state["processRunning"] and state["message"] == "进程仍在退出"
