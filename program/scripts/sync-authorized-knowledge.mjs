import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const wranglerCli = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const sourceFile = fileURLToPath(new URL("../resources/authorized/dbskill/atoms.jsonl", import.meta.url));
const localDirectory = fileURLToPath(new URL("../.local/", import.meta.url));
const sqlFile = fileURLToPath(new URL("../.local/authorized-knowledge-sync.sql", import.meta.url));
const SOURCE_ID = "liming-zhiyao-authorized-methods-v1";
const LEGACY_SOURCE_IDS = ["dbskill"];
const SKILL_PREFIX = "liming-method-";
const SOURCE_NAME = "利明智耀授权方法库";
const SOURCE_REVISION = "d18f556332bdbcf13a87bf61e531f7207d676b74";

const environment = {
  ...process.env,
  WRANGLER_WRITE_LOGS: "false",
  WRANGLER_LOG_PATH: ".wrangler/logs",
  MINIFLARE_REGISTRY_PATH: ".wrangler/registry",
};

function runWrangler(arguments_, options = {}) {
  return spawnSync(process.execPath, [wranglerCli, ...arguments_], {
    cwd: projectRoot,
    env: environment,
    encoding: "utf8",
    ...options,
  });
}

function sqlText(value) {
  if (value === null || value === undefined || value === "") return "NULL";
  return `'${String(value).replaceAll("\0", "").replaceAll("'", "''")}'`;
}

export function normalizeSkillTag(value) {
  const tag = String(value || "").trim().slice(0, 100);
  if (!tag) return "";
  const normalizedTag = tag.toLowerCase();
  if (normalizedTag.startsWith(SKILL_PREFIX)) return normalizedTag;
  if (normalizedTag.startsWith("dbs-")) return `${SKILL_PREFIX}${normalizedTag.slice(4)}`;
  return tag;
}

export function parseAtoms() {
  const rows = readFileSync(sourceFile, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
    const atom = JSON.parse(line);
    for (const field of ["id", "knowledge", "original", "type", "confidence"]) {
      if (typeof atom[field] !== "string" || !atom[field].trim()) throw new Error(`Atom ${index + 1} has an invalid ${field}.`);
    }
    return {
      id: atom.id.trim(),
      knowledge: atom.knowledge.trim(),
      original: atom.original.trim(),
      url: typeof atom.url === "string" ? atom.url.trim() : null,
      date: typeof atom.date === "string" ? atom.date.trim() : null,
      topics: Array.isArray(atom.topics) ? atom.topics.filter((item) => typeof item === "string") : [],
      skills: Array.isArray(atom.skills) ? [...new Set(atom.skills.filter((item) => typeof item === "string").map(normalizeSkillTag).filter(Boolean))].slice(0, 30) : [],
      type: atom.type.trim(),
      confidence: atom.confidence.trim(),
    };
  });
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("Authorized knowledge contains duplicate atom IDs.");
  return rows;
}

function existingSource() {
  const result = runWrangler([
    "d1", "execute", "DB", "--local", "--config", "wrangler.local.jsonc", "--json",
    "--command", `SELECT revision, item_count FROM authorized_knowledge_sources WHERE id = '${SOURCE_ID}' LIMIT 1`,
  ]);
  if (result.status !== 0) return null;
  try {
    const payload = JSON.parse(result.stdout);
    return payload?.[0]?.results?.[0] ?? null;
  } catch {
    return null;
  }
}

export function buildSql(atoms) {
  const syncedAt = new Date().toISOString();
  const sourceList = [SOURCE_ID, ...LEGACY_SOURCE_IDS].map(sqlText).join(", ");
  const statements = [
    `DELETE FROM authorized_knowledge_atoms WHERE source_id IN (${sourceList});`,
    `DELETE FROM authorized_knowledge_sources WHERE id IN (${sourceList});`,
    `INSERT INTO authorized_knowledge_sources (id, name, revision, item_count, synced_at) VALUES (${sqlText(SOURCE_ID)}, ${sqlText(SOURCE_NAME)}, ${sqlText(SOURCE_REVISION)}, 0, ${sqlText(syncedAt)});`,
  ];
  for (let index = 0; index < atoms.length; index += 80) {
    const values = atoms.slice(index, index + 80).map((atom) => `(${sqlText(atom.id)}, ${sqlText(SOURCE_ID)}, ${sqlText(atom.knowledge)}, ${sqlText(atom.original)}, ${sqlText(atom.url)}, ${sqlText(atom.date)}, ${sqlText(JSON.stringify(atom.topics))}, ${sqlText(JSON.stringify(atom.skills))}, ${sqlText(atom.type)}, ${sqlText(atom.confidence)})`);
    statements.push(`INSERT INTO authorized_knowledge_atoms (id, source_id, knowledge, original, url, published_at, topics_json, skills_json, atom_type, confidence) VALUES\n${values.join(",\n")};`);
  }
  statements.push(`UPDATE authorized_knowledge_sources SET item_count = ${atoms.length}, synced_at = ${sqlText(syncedAt)} WHERE id = ${sqlText(SOURCE_ID)};`);
  return statements.join("\n");
}

function clearLegacyOrBundledSources() {
  const legacyList = LEGACY_SOURCE_IDS.map(sqlText).join(", ");
  const result = runWrangler([
    "d1", "execute", "DB", "--local", "--config", "wrangler.local.jsonc",
    "--command", [
      `DELETE FROM authorized_knowledge_atoms WHERE source_id IN (${legacyList}) OR source_id IN (SELECT id FROM authorized_knowledge_sources WHERE id = ${sqlText(SOURCE_ID)} AND revision = ${sqlText(SOURCE_REVISION)});`,
      `DELETE FROM authorized_knowledge_sources WHERE id IN (${legacyList}) OR (id = ${sqlText(SOURCE_ID)} AND revision = ${sqlText(SOURCE_REVISION)});`,
    ].join(" "),
  ]);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}

export function synchronizeAuthorizedKnowledge() {
  if (!existsSync(sourceFile)) {
    clearLegacyOrBundledSources();
    console.log("[Authorized knowledge] This installation does not include a built-in method library. Import an authorized method package from the Brand Knowledge page when needed.");
    return;
  }

  const atoms = parseAtoms();
  const current = existingSource();
  if (current?.revision === SOURCE_REVISION && Number(current.item_count) === atoms.length) {
    console.log(`[Authorized knowledge] ${atoms.length} atoms are already synchronized.`);
    return;
  }

  mkdirSync(localDirectory, { recursive: true });
  writeFileSync(sqlFile, buildSql(atoms), "utf8");
  const result = runWrangler(["d1", "execute", "DB", "--local", "--config", "wrangler.local.jsonc", "--file", sqlFile]);
  try { unlinkSync(sqlFile); } catch { /* best-effort temporary cleanup */ }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.status ?? 1;
    return;
  }
  console.log(`[Authorized knowledge] Synchronized ${atoms.length} atoms from ${SOURCE_NAME}@${SOURCE_REVISION.slice(0, 7)}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) synchronizeAuthorizedKnowledge();
