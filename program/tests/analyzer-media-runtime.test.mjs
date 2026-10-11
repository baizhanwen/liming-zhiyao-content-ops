import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("multiple FFmpeg installations resolve to one executable for automatic and named configuration", { skip: process.platform !== "win32" }, (t) => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const testRoot = path.join(root, ".local");
  mkdirSync(testRoot, { recursive: true });
  const fixture = mkdtempSync(path.join(testRoot, "media-runtime-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(testRoot));
    rmSync(fixture, { recursive: true, force: true });
  });
  const directories = ["first install", "second install"].map((name) => path.join(fixture, name));
  for (const directory of directories) {
    mkdirSync(directory);
    // Discovery only: no media executable is run by this test.
    for (const name of ["ffmpeg", "ffprobe"]) {
      copyFileSync(path.join(process.env.SystemRoot, "System32", "cmd.exe"), path.join(directory, `${name}.exe`));
    }
  }
  const script = `
$ErrorActionPreference = 'Stop'
. (Join-Path $env:MEDIA_TEST_ROOT 'scripts/analyzer-media-runtime.ps1')
$env:Path = $env:MEDIA_TEST_PATH
Remove-Item Env:ANALYZER_FFMPEG, Env:ANALYZER_FFPROBE -ErrorAction SilentlyContinue
$automatic = Import-AnalyzerMediaRuntime $env:MEDIA_TEST_FIXTURE
$env:ANALYZER_FFMPEG = 'ffmpeg.exe'
$env:ANALYZER_FFPROBE = 'ffprobe.exe'
$named = Import-AnalyzerMediaRuntime $env:MEDIA_TEST_FIXTURE
[pscustomobject]@{ automatic = $automatic; named = $named; ffmpeg = $env:ANALYZER_FFMPEG; ffprobe = $env:ANALYZER_FFPROBE } | ConvertTo-Json -Compress
`;
  const result = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    cwd: root,
    env: { ...process.env, MEDIA_TEST_ROOT: root, MEDIA_TEST_FIXTURE: fixture, MEDIA_TEST_PATH: directories.join(";") },
    encoding: "utf8", windowsHide: true, timeout: 20000,
  }).trim());
  for (const mode of ["automatic", "named"]) {
    assert.equal(result[mode].Ffmpeg, path.join(directories[0], "ffmpeg.exe"));
    assert.equal(result[mode].Ffprobe, path.join(directories[0], "ffprobe.exe"));
  }
  assert.equal(result.ffmpeg, result.named.Ffmpeg);
  assert.equal(result.ffprobe, result.named.Ffprobe);
});
