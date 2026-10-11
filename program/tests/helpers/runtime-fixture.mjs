import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import ts from "typescript";
import * as zod from "zod";

const root = fileURLToPath(new URL("../..", import.meta.url));

export function runtimeFixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  for (const file of readdirSync(path.join(root, "drizzle")).filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(root, "drizzle", file), "utf8"));
  const db = {
    prepare(query) {
      let args = [];
      const statement = {
        bind(...values) { args = values; return statement; },
        async first() { return sqlite.prepare(query).get(...args) ?? null; },
        async all() { return { results: sqlite.prepare(query).all(...args) }; },
        execute() {
          const prepared = sqlite.prepare(query);
          if (/^\s*SELECT\b/i.test(query)) return { results: prepared.all(...args), meta: { changes: 0 } };
          return { results: [], meta: { changes: Number(prepared.run(...args).changes) } };
        },
        async run() { return statement.execute(); },
      };
      return statement;
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try { const results = statements.map(s => s.execute()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  const identity = { userId: "", role: "admin" };
  const runtime = {
    getD1: () => db,
    sha256Hex: async bytes => createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
    makeSlug: (_name, id) => `test-${id}`,
    ensureUser: async () => ({ id: identity.userId }),
    getOrganizationAccess: async () => ({ organizationRole: identity.role }),
  };
  const mocks = new Map([
    ["zod", zod],
    ["cloudflare:workers", { env: { DELIVERY_MODE: "1", FIRST_RUN_SETUP_CODE: "synthetic-test-code" } }],
    [path.join(root, "db/runtime.ts"), runtime],
    [path.join(root, "lib/request-auth.ts"), { readRequestIdentity: async () => ({ authSubject: identity.userId }) }],
  ]);
  const cache = new Map();
  function load(relative) {
    const filename = path.resolve(root, relative);
    if (mocks.has(filename)) return mocks.get(filename);
    if (cache.has(filename)) return cache.get(filename);
    const source = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const loaded = { exports: {} };
    const require = name => {
      if (mocks.has(name)) return mocks.get(name);
      if (!name.startsWith(".")) throw new Error(`Unmocked dependency: ${name}`);
      return load(path.resolve(path.dirname(filename), name.endsWith(".ts") ? name : name + ".ts"));
    };
    new Function("require", "module", "exports", source)(require, loaded, loaded.exports);
    cache.set(filename, loaded.exports);
    return loaded.exports;
  }
  const initialize = (index = 0) => load("lib/first-run.ts").initializeCommercialInstallation({ companyName: `Test company ${index}`, administratorName: `Test admin ${index}`, email: `test-${index}@example.invalid`, password: "synthetic-password-only", setupCode: "synthetic-test-code" });
  return { sqlite, db, load, identity, initialize, runtime, mockModule: (name, exports) => mocks.set(name, exports), mock: (relative, exports) => mocks.set(path.resolve(root, relative), exports) };
}
