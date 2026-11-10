import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseLocalRuntimeConfiguration } from "./analyzer-environment-bridge.mjs";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));

function rejectSymlink(target) {
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error("Runtime configuration must stay inside this project's own directory.");
}

async function lockConfiguration(root) {
  const local = path.join(root, ".local");
  rejectSymlink(local); mkdirSync(local, { recursive: true });
  const lockPath = path.join(local, "runtime-configuration.lock");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      return async () => { await handle.close(); await unlink(lockPath).catch(() => {}); };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = Number(readFileSync(lockPath, "utf8"));
        if (Number.isSafeInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); } catch (reason) { if (reason.code === "ESRCH") { await unlink(lockPath).catch(() => {}); continue; } }
        }
      } catch { /* The process acquiring the lock may still be writing its PID. */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw new Error("This project's runtime configuration is being prepared by another startup. Retry shortly.");
}

/** Generate project-local secrets once. No secret is returned or printed. */
export async function prepareRuntimeConfiguration(root = defaultRoot) {
  root = path.resolve(root);
  const release = await lockConfiguration(root);
  try {
    const target = path.join(root, ".dev.vars");
    const template = path.join(root, ".dev.vars.example");
    rejectSymlink(target); rejectSymlink(template);
    const created = !existsSync(target);
    let content = readFileSync(created ? template : target, "utf8");
    const existing = parseLocalRuntimeConfiguration(content);
    let updated = created;
    const lineEnding = content.includes("\r\n") ? "\r\n" : content.includes("\n") ? "\n" : content.includes("\r") ? "\r" : "\n";
    const set = (name, value) => {
      // Multiline ^ can match between CR and LF. A \s prefix would consume
      // that LF and join the setting to its preceding comment on Windows.
      const pattern = new RegExp(`^[ \\t]*${name}[ \\t]*=[^\\r\\n]*`, "mu");
      if (pattern.test(content)) content = content.replace(pattern, `${name}=${value}`);
      else {
        const separator = content && !/[\r\n]$/u.test(content) ? lineEnding : "";
        content = `${content}${separator}${name}=${value}${lineEnding}`;
      }
      updated = true;
    };
    const encryptionKey = existing.MODEL_SETTINGS_ENCRYPTION_KEY?.trim() ?? "";
    if (!encryptionKey) set("MODEL_SETTINGS_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
    else if (!/^[a-f\d]{64}$/iu.test(encryptionKey)) throw new Error("The existing model-settings encryption key is invalid; it has been preserved to protect saved configuration.");
    for (const name of ["LOCAL_RUNTIME_TOKEN", "ANALYZER_SERVICE_TOKEN"]) {
      const current = existing[name]?.trim() ?? "";
      if (!current || /change-me|replace-with/iu.test(current)) set(name, randomBytes(32).toString("hex"));
    }
    if (!existing.LOCAL_RUNTIME_URL?.trim()) set("LOCAL_RUNTIME_URL", "http://127.0.0.1:3001");
    if (updated) {
      const pending = path.join(root, `.dev.vars.prepare-${randomUUID()}`);
      try { writeFileSync(pending, content, { mode: 0o600, flag: "wx" }); renameSync(pending, target); }
      finally { if (existsSync(pending)) unlinkSync(pending); }
    }
    chmodSync(target, 0o600);
    return { created, updated, configured: true };
  } finally { await release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await prepareRuntimeConfiguration(); console.log("This project's local runtime configuration is ready."); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
