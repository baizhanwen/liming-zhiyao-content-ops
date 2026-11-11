import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { evaluateNodeRuntime } from "../scripts/node-runtime-policy.mjs";

test("Windows accepts only the supported x64 LTS version ranges", () => {
  for (const [version, supported] of [
    ["18.20.8", false], ["20.19.0", false], ["22.12.99", false], ["22.13.0", true],
    ["v22.13.1", true], ["22.22.1", true], ["23.0.0", false], ["23.11.1", false],
    ["24.0.0", false], ["24.19.99", false], ["24.20.0", true], ["24.22.2", true],
    ["25.0.0", false], ["26.4.0", false], ["27.0.0", false],
  ]) {
    const result = evaluateNodeRuntime({ version, arch: "x64", platform: "win32" });
    assert.equal(result.supported, supported, version);
    if (!supported) assert.match(result.message, /22\.13.*24\.20.*setup-local\.bat/u);
  }
  for (const arch of ["ia32", "arm64", "arm", "", undefined]) {
    const result = evaluateNodeRuntime({ version: "24.20.0", arch, platform: "win32" });
    assert.equal(result.supported, false, String(arch));
    assert.equal(result.code, "unsupported_arch");
  }
});

test("non-Windows platforms retain the project's existing minimum including macOS ARM", () => {
  for (const platform of ["darwin", "linux", "freebsd"]) {
    for (const [version, supported] of [["20.19.0", false], ["22.12.0", false], ["22.13.0", true], ["23.0.0", true], ["24.19.0", true], ["26.0.0", true]]) {
      assert.equal(evaluateNodeRuntime({ version, platform, arch: "arm64" }).supported, supported, `${platform} ${version}`);
    }
  }
});

test("invalid and prerelease versions are refused with fixed guidance", () => {
  for (const version of [null, undefined, 24, "", "24", "24.20", "999999999999999999999.20.0", "24.20.0-rc.1", "24.20.0; echo private", "24.20.0\nprivate"]) {
    for (const platform of ["win32", "darwin"]) {
      const result = evaluateNodeRuntime({ version, platform, arch: "x64" });
      assert.equal(result.supported, false, String(version));
      assert.equal(result.code, "invalid_version");
      assert.doesNotMatch(result.message, /private|echo/u);
    }
  }
});

test("CLI uses the real runtime and returns its support result without exposing paths", () => {
  const script = fileURLToPath(new URL("../scripts/node-runtime-policy.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
  const expected = evaluateNodeRuntime({ version: process.versions.node, arch: process.arch, platform: process.platform });
  assert.equal(result.status, expected.supported ? 0 : 1);
  assert.equal(result.stdout, expected.message + "\n");
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(process.execPath));
});

test("setup, web startup and the collector share the policy rather than accepting every newer major", () => {
  for (const name of ["setup-local.bat", "scripts/prepare-local-web.ps1", "scripts/analyzer-collector-runtime.ps1", "scripts/start-lan.ps1"]) {
    const source = readFileSync(new URL("../" + name, import.meta.url), "utf8");
    assert.match(source, /Find-NodeRuntime/u, name);
    assert.match(source, /install-node22\.ps1/u, name);
    assert.doesNotMatch(source, /major > 22/u, name);
  }
  for (const name of ["setup-local.bat", "start-local.bat"]) {
    const bytes = readFileSync(new URL("../" + name, import.meta.url));
    assert.ok(bytes.every(byte => byte < 128), `${name} must remain ASCII`);
    assert.doesNotMatch(bytes.toString("ascii"), /(?<!\r)\n/u, `${name} must remain CRLF`);
    assert.match(bytes.toString("ascii"), /LMZY_NODE_HOME/u, name);
  }
});
