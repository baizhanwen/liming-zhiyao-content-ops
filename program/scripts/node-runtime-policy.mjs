import path from "node:path";
import { pathToFileURL } from "node:url";

const windowsGuidance = "Use Windows x64 Node.js 22.13 or newer in 22.x, or 24.20 or newer in 24.x. Run setup-local.bat to prepare this project's runtime.";
const minimumGuidance = "This project requires Node.js 22.13 or newer. Prepare a supported Node.js runtime, then start again.";

/** One runtime policy shared by setup, the web launcher and the collector. */
export function evaluateNodeRuntime({ version, arch, platform } = {}) {
  const match = typeof version === "string" ? /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version) : null;
  if (!match || match.slice(1).some(part => !Number.isSafeInteger(Number(part)))) return { supported: false, code: "invalid_version", message: platform === "win32" ? windowsGuidance : minimumGuidance };
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (platform === "win32") {
    if (arch !== "x64") return { supported: false, code: "unsupported_arch", message: windowsGuidance };
    if ((major === 22 && minor >= 13) || (major === 24 && minor >= 20)) {
      return { supported: true, code: "supported", message: "Supported Windows x64 Node.js runtime." };
    }
    return {
      supported: false,
      code: major === 23 || (major === 24 && minor < 20) ? "unsupported_windows_release" : major === 22 ? "below_minimum" : "unverified_windows_major",
      message: windowsGuidance,
    };
  }
  const supported = major > 22 || (major === 22 && minor >= 13);
  return { supported, code: supported ? "supported" : "below_minimum", message: supported ? "Supported Node.js runtime." : minimumGuidance };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = evaluateNodeRuntime({ version: process.versions.node, arch: process.arch, platform: process.platform });
  process.stdout.write(result.message + "\n");
  process.exitCode = result.supported ? 0 : 1;
}
