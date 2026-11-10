import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace


def runtime_module():
    path = Path(__file__).resolve().parents[3] / "scripts/analyzer_local_runtime.py"
    spec = importlib.util.spec_from_file_location("analyzer_local_runtime_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def isolate(module, tmp_path, monkeypatch):
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module, "LOCAL", tmp_path / ".local")
    monkeypatch.setattr(module, "ANALYZER", tmp_path / "services/analyzer")
    monkeypatch.setattr(module, "PID_FILE", tmp_path / ".local/analyzer-local.json")


def test_runtime_does_not_inherit_other_project_configuration(tmp_path, monkeypatch):
    module = runtime_module()
    isolate(module, tmp_path, monkeypatch)
    monkeypatch.setenv("ANALYZER_LLM_API_KEY", "other-project-key")
    monkeypatch.setenv("HF_TOKEN", "other-project-hf-key")
    monkeypatch.setenv("PYTHONPATH", "/other/project")
    monkeypatch.setenv("PADDLE_PDX_CACHE_HOME", "/other/cache")
    env = module.runtime_environment(load_configuration=False)
    assert "ANALYZER_LLM_API_KEY" not in env and "HF_TOKEN" not in env
    assert env["PYTHONPATH"] == str(tmp_path / "services/analyzer")
    for key in ("PADDLE_PDX_CACHE_HOME", "MODELSCOPE_CACHE", "HF_HOME", "TORCH_HOME", "XDG_CACHE_HOME", "PLAYWRIGHT_BROWSERS_PATH"):
        assert Path(env[key]).is_relative_to(tmp_path)


def test_ready_setup_is_idempotent_even_with_running_worker(monkeypatch, capsys):
    module = runtime_module()
    monkeypatch.setattr(module, "readiness_snapshot", lambda: {"ready": True, "workerRunning": True, "checks": [], "missing": []})
    monkeypatch.setattr(module, "resolve_media_tools", lambda *_args: {"ffmpeg": "fixture-ffmpeg", "ffprobe": "fixture-ffprobe"})
    monkeypatch.setattr(module, "_test_media_binary", lambda _path: True)
    monkeypatch.setattr(module.subprocess, "run", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("ready setup must not reinstall")))
    assert module.setup() == 0
    result = json.loads(capsys.readouterr().out)
    assert result["alreadyPrepared"] and result["alreadyRunning"]


def test_missing_uv_is_bootstrapped_inside_project(tmp_path, monkeypatch, capsys):
    module = runtime_module()
    isolate(module, tmp_path, monkeypatch)
    module.LOCAL.mkdir()
    snapshots = iter([{"ready": False, "workerRunning": False}, {"ready": True, "workerRunning": False, "missing": []}])
    monkeypatch.setattr(module, "readiness_snapshot", lambda: next(snapshots))
    monkeypatch.setattr(module, "active_process", lambda: None)
    monkeypatch.setattr(module.shutil, "which", lambda name, **_kwargs: "/fixture/npm" if name in {"npm", "npm.cmd"} else None)
    monkeypatch.setattr(module, "runtime_environment", lambda **_kwargs: {})
    created = []
    class Builder:
        def __init__(self, **_kwargs):
            pass
        def create(self, path):
            created.append(Path(path))
            Path(path).mkdir(parents=True)
    monkeypatch.setattr(module.venv, "EnvBuilder", Builder)
    commands = []
    def run(command, **_kwargs):
        commands.append(command)
        if "--target" in command:
            destination = Path(command[command.index("--target") + 1])
            executable = destination / "bin" / ("uv.exe" if module.os.name == "nt" else "uv")
            executable.parent.mkdir(parents=True)
            executable.write_text("fixture")
            executable.chmod(0o700)
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(module.subprocess, "run", run)
    assert module.setup() == 0
    assert created == [tmp_path / ".local/installer-venv"]
    assert commands[0][commands[0].index("--target") + 1] == str(tmp_path / ".local/installer-tools")
    assert commands[1][0] == str(tmp_path / ".local/installer-tools/bin" / ("uv.exe" if module.os.name == "nt" else "uv"))
    assert json.loads(capsys.readouterr().out.splitlines()[-1])["ready"]


def test_recorded_project_media_tools_restore_worker_path_without_parent_process_reload(tmp_path, monkeypatch):
    module = runtime_module()
    isolate(module, tmp_path, monkeypatch)
    module.LOCAL.mkdir()
    binaries = module.LOCAL / "media-tools/node_modules/fixture-platform"
    binaries.mkdir(parents=True)
    suffix = ".exe" if module.os.name == "nt" else ""
    for name in ("ffmpeg", "ffprobe"):
        path = binaries / (name + suffix)
        path.write_text("synthetic binary fixture")
        path.chmod(0o700)
    (module.LOCAL / "ffmpeg.path").write_text(str(binaries) + "\n")
    monkeypatch.setattr(module.shutil, "which", lambda *_args, **_kwargs: None)
    env = module.runtime_environment(load_configuration=False)
    assert env["ANALYZER_FFMPEG"] == str((binaries / ("ffmpeg" + suffix)).resolve())
    assert env["ANALYZER_FFPROBE"] == str((binaries / ("ffprobe" + suffix)).resolve())
    assert str(binaries) in env["PATH"].split(module.os.pathsep)


def test_missing_media_tools_install_only_from_locked_project_manifest(tmp_path, monkeypatch, capsys):
    module = runtime_module()
    isolate(module, tmp_path, monkeypatch)
    resources = tmp_path / "resources/media-tools"
    resources.mkdir(parents=True)
    (resources / "package.json").write_text('{"private":true}')
    (resources / "package-lock.json").write_text('{"lockfileVersion":3}')
    monkeypatch.setattr(module, "runtime_environment", lambda **_kwargs: {})
    monkeypatch.setattr(module.shutil, "which", lambda name, **_kwargs: "/fixture/" + name if name in {"npm", "npm.cmd", "node"} else None)
    folder = module.LOCAL / "media-tools"
    bin_dir = folder / "node_modules/fixture-platform"
    suffix = ".exe" if module.os.name == "nt" else ""
    pair = {name: str(bin_dir / (name + suffix)) for name in ("ffmpeg", "ffprobe")}
    commands = []
    def run(command, **_kwargs):
        commands.append(command)
        if "ci" in command:
            bin_dir.mkdir(parents=True)
            for path in pair.values():
                Path(path).write_text("synthetic executable fixture")
            return SimpleNamespace(returncode=0)
        if "-e" in command:
            return SimpleNamespace(returncode=0, stdout=json.dumps(pair))
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(module.subprocess, "run", run)
    assert module.install_media_packages() == 0
    assert commands[0][1:] == ["ci", "--prefix", str(folder), "--omit=dev", "--no-audit", "--no-fund"]
    assert (folder / "package-lock.json").read_text() == (resources / "package-lock.json").read_text()
    assert json.loads((module.LOCAL / "media-tools.json").read_text())["ffmpeg"] == pair["ffmpeg"]
    assert (module.LOCAL / "ffmpeg.path").read_text().strip() == str(bin_dir)
    assert all(Path(path).is_relative_to(tmp_path) for path in pair.values())
    assert json.loads(capsys.readouterr().out)["ready"]
