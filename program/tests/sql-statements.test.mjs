import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { splitSql } from "../scripts/sql-statements.mjs";

test("migration splitter preserves trigger blocks, nested CASE and quoted semicolons", () => {
  const sql = `-- ignored ;
    CREATE TABLE records (id INTEGER, value TEXT);
    INSERT INTO records VALUES(1, 'it''s; quoted -- text');
    CREATE TRIGGER protect BEFORE UPDATE ON records BEGIN
      SELECT CASE WHEN OLD.id=1 THEN RAISE(ABORT,'preserve; original') END;
      SELECT 'second; statement';
    END;
    /* ignored ; */ SELECT value FROM records;`;
  const statements = splitSql(sql); assert.equal(statements.length, 4);
  const db = new DatabaseSync(":memory:");
  try {
    for (const statement of statements) db.exec(statement);
    assert.equal(db.prepare("SELECT value FROM records").get().value, "it's; quoted -- text");
    assert.throws(() => db.exec("UPDATE records SET value='lost'"), /preserve; original/);
  } finally { db.close(); }
});

test("every current migration yields the same schema through one-statement D1 preparation", () => {
  const direct = new DatabaseSync(":memory:"), split = new DatabaseSync(":memory:");
  try {
    for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter(f => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
      direct.exec(sql);
      for (const statement of splitSql(sql)) split.prepare(statement).run();
    }
    const schema = db => db.prepare("SELECT type,name,tbl_name FROM sqlite_master ORDER BY name").all();
    assert.deepEqual(schema(split), schema(direct));
    assert.equal(split.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'ecommerce_%'").get().n, 5);
  } finally { direct.close(); split.close(); }
});
