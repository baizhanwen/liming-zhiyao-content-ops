import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("authorized Liming Zhiyao methodology is versioned and used by topic and content prompts", async () => {
  const [methodology, production, topics, analyzer] = await Promise.all([
    import("../lib/authorized-content-methodology.ts"),
    import("../lib/content-production.ts"),
    readFile(new URL("../lib/topic-generation.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/analyzer/liming_analyzer/providers.py", import.meta.url), "utf8"),
  ]);

  assert.equal(methodology.AUTHORIZED_METHODOLOGY_SOURCE.name, "利明智耀授权方法库");
  assert.equal(methodology.AUTHORIZED_METHODOLOGY_SOURCE.revision.length, 40);
  assert.match(production.CONTENT_SYSTEM_PROMPT, /单一核心机制/);
  assert.match(production.CONTENT_SYSTEM_PROMPT, /选题、已启用策略/);
  assert.match(production.CONTENT_PROMPT_VERSION, /v10-material-feedback-loop$/);
  assert.match(topics, /TOPIC_CREATION_METHODOLOGY/);
  assert.match(topics, /topic-fields\.v3-knowledge/);
  assert.match(analyzer, /video-analysis\.v6/);
});

test("new production packs expose a visible structured quality review", async () => {
  const production = await import("../lib/content-production.ts");
  const scaffold = production.createProductionScaffold({ id: "topic-licensed", title: "老板必须懂的 AI 概念" });

  assert.equal(production.productionPackSchema.safeParse(scaffold).success, true);
  assert.equal(scaffold.qualityReview.publishReadiness, "revise");
  assert.equal(production.CONTENT_OUTPUT_SCHEMA.required.includes("qualityReview"), true);

  const invalidMethod = {
    ...scaffold,
    qualityReview: {
      ...scaffold.qualityReview,
      benchmarkMethods: [{ sourceId: "", method: "学习悬念", application: "调整开头" }],
    },
  };
  assert.equal(production.productionPackSchema.safeParse(invalidMethod).success, false);
});

test("content production UI renders readiness, resonance, flow and benchmark method evidence", async () => {
  const workspace = await readFile(new URL("../components/ContentProductionWorkspace.tsx", import.meta.url), "utf8");
  for (const label of ["内容方法诊断", "五维共鸣", "本次采用的对标方法", "逻辑与口播风险", "审核前阻塞项"]) {
    assert.match(workspace, new RegExp(label));
  }
});

test("all authorized atoms are bundled, branded, migrated into D1, and retrieved per task", async () => {
  const [atomsFile, migration, syncScript, knowledge, syncModule] = await Promise.all([
    readFile(new URL("../resources/authorized/dbskill/atoms.jsonl", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0015_authorized_method_knowledge.sql", import.meta.url), "utf8"),
    readFile(new URL("../scripts/sync-authorized-knowledge.mjs", import.meta.url), "utf8"),
    import("../lib/authorized-knowledge.ts"),
    import("../scripts/sync-authorized-knowledge.mjs"),
  ]);
  assert.equal(atomsFile.trim().split(/\r?\n/).length, 4176);
  assert.match(migration, /authorized_knowledge_atoms/);
  assert.match(syncScript, /Synchronized \$\{atoms\.length\} atoms/);
  const normalizedAtoms = syncModule.parseAtoms();
  assert.equal(normalizedAtoms.length, 4176);
  assert.ok(normalizedAtoms.every((atom) => atom.skills.every((skill) => skill.startsWith("liming-method-") || !skill.startsWith("dbs-"))));
  const migrationSql = syncModule.buildSql(normalizedAtoms.slice(0, 2));
  assert.match(migrationSql, /liming-zhiyao-authorized-methods-v1/);
  assert.match(migrationSql, /DELETE FROM authorized_knowledge_atoms WHERE source_id IN \('liming-zhiyao-authorized-methods-v1', 'dbskill'\)/);
  assert.doesNotMatch(migrationSql.match(/INSERT INTO authorized_knowledge_atoms[\s\S]+/)?.[0] ?? "", /"dbs-/);

  const candidates = [
    { id: "strong", source_id: knowledge.AUTHORIZED_KNOWLEDGE_SOURCE_ID, knowledge: "企业老板做 AI 内容要先说清楚客户问题", original: "老板需要从真实客户问题进入内容。", url: "https://example.com/strong", published_at: "2026-01-01", topics_json: '["内容创作与平台","AI与工具"]', skills_json: '["liming-method-content"]', atom_type: "method", confidence: "high" },
    { id: "weak", source_id: knowledge.AUTHORIZED_KNOWLEDGE_SOURCE_ID, knowledge: "记录生活", original: "随手记录。", url: null, published_at: "2025-01-01", topics_json: '["人生哲学与价值观"]', skills_json: '[]', atom_type: "insight", confidence: "low" },
  ];
  let firstBinding;
  const fakeDb = { prepare() { return { bind(...values) { firstBinding = values[0]; return { async all() { return { results: candidates }; } }; } }; } };
  const result = await knowledge.retrieveAuthorizedKnowledge(fakeDb, "中小企业老板必须懂的 AI 内容概念", { task: "content", limit: 2 });
  assert.equal(firstBinding, "liming-zhiyao-authorized-methods-v1");
  assert.equal(result[0].id, "strong");
  assert.ok(result[0].matchedTerms.includes("企业") || result[0].matchedTerms.includes("老板"));
  assert.deepEqual(knowledge.normalizeAuthorizedKnowledgeSkillTags(["dbs-content", "liming-method-content", "DBS-DECONSTRUCT"]), ["liming-method-content", "liming-method-deconstruct"]);
});

test("authorized library remains manageable while generation routes stay project-isolated", async () => {
  const [topicRoute, contentRoute, saveRoute, knowledgeApi, workspace, topicWorkspace] = await Promise.all([
    readFile(new URL("../app/api/topics/generate/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/content-items/[contentId]/generate/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/content-items/[contentId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/authorized-knowledge/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/KnowledgeWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/TopicWorkspace.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(topicRoute, /retrieveAuthorizedKnowledge|authorizedMethodKnowledge|\.original\b/);
  assert.doesNotMatch(contentRoute, /retrieveAuthorizedKnowledge|authorizedKnowledge|\.original\b/);
  assert.match(saveRoute, /authorized_knowledge_atoms/);
  assert.match(knowledgeApi, /item_count/);
  assert.match(workspace, /授权方法库/);
  assert.match(workspace, /查看授权原文与来源/);
  assert.match(topicWorkspace, /本次只使用当前客户项目内的资料/);
});
