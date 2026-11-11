"""Build a wheel offline and verify resources from the wheel, not the source tree."""
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest


def test_content_taxonomy_is_in_the_installable_wheel(tmp_path):
    pytest.importorskip("setuptools")
    analyzer = Path(__file__).resolve().parents[1]
    source = tmp_path / "package-source"
    shutil.copytree(analyzer, source, ignore=shutil.ignore_patterns(
        ".venv", "node_modules", "__pycache__", "*.egg-info", "build", "dist",
        ".pytest_cache", ".ruff_cache", "tests",
    ))
    destination = tmp_path / "wheels"
    destination.mkdir()
    result = subprocess.run([
        sys.executable, "-c",
        "import sys; from setuptools.build_meta import build_wheel; build_wheel(sys.argv[1])",
        str(destination),
    ], cwd=source, capture_output=True, text=True, check=False, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    wheels = list(destination.glob("*.whl"))
    assert len(wheels) == 1
    with zipfile.ZipFile(wheels[0]) as wheel:
        resource = "liming_analyzer/resources/video-taxonomy.v1.json"
        assert resource in wheel.namelist()
        taxonomy = json.loads(wheel.read(resource))
        assert taxonomy["version"] == "video-taxonomy.v1"
        assert len(taxonomy["dimensions"]) == 65
        assert "liming_analyzer/content_analysis.py" in wheel.namelist()
        assert "liming_analyzer/content_metrics.py" in wheel.namelist()
        for module in ("canonical_transcript", "content_module_protocol", "unified_analysis"):
            assert f"liming_analyzer/{module}.py" in wheel.namelist()
    # A resource existing in the ZIP is insufficient: importlib.resources must
    # also read it when the wheel is the package source.
    result = subprocess.run([
        sys.executable, "-c",
        ("import sys; sys.path.insert(0,sys.argv[1]); "
        "import liming_analyzer.content_analysis as module; "
        "import liming_analyzer.canonical_transcript as canonical; "
        "import liming_analyzer.content_module_protocol as protocol; "
        "import liming_analyzer.unified_analysis as unified; "
        "assert module.__file__.startswith(sys.argv[1]); "
        "assert all(item.__file__.startswith(sys.argv[1]) for item in (canonical,protocol,unified)); "
        "assert module.load_taxonomy()['version']=='video-taxonomy.v1'; "
        "assert len(module.load_taxonomy()['dimensions'])==65"),
        str(wheels[0]),
    ], cwd=tmp_path, capture_output=True, text=True, check=False, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr
