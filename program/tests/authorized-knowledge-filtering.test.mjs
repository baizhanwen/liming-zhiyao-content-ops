import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORIZED_KNOWLEDGE_SOURCE_ID,
  retrieveAuthorizedKnowledge,
} from "../lib/authorized-knowledge.ts";

test("generation retrieval filters atom type and confidence before ranking", async () => {
  const candidates = [
    {
      id: "usable-method", source_id: AUTHORIZED_KNOWLEDGE_SOURCE_ID,
      knowledge: "短视频开头要服务正文核心主张", original: "开头和正文必须兑现同一个主张。",
      url: null, published_at: "2026-01-01", topics_json: '["内容创作与平台"]',
      skills_json: '["liming-method-content"]', atom_type: "method", confidence: "medium",
    },
    {
      id: "raw-insight", source_id: AUTHORIZED_KNOWLEDGE_SOURCE_ID,
      knowledge: "短视频随便说说也可以", original: "个人随想。",
      url: null, published_at: "2026-01-02", topics_json: '["内容创作与平台"]',
      skills_json: '["liming-method-content"]', atom_type: "insight", confidence: "high",
    },
    {
      id: "low-principle", source_id: AUTHORIZED_KNOWLEDGE_SOURCE_ID,
      knowledge: "短视频开头必须夸张", original: "未经验证的说法。",
      url: null, published_at: "2026-01-03", topics_json: '["内容创作与平台"]',
      skills_json: '["liming-method-content"]', atom_type: "principle", confidence: "low",
    },
  ];
  let sql = "";
  let bindings = [];
  const db = {
    prepare(value) {
      sql = value;
      return {
        bind(...values) {
          bindings = values;
          return { async all() { return { results: candidates }; } };
        },
      };
    },
  };

  const result = await retrieveAuthorizedKnowledge(db, "短视频开头", {
    task: "content",
    limit: 8,
    allowedAtomTypes: ["method", "principle", "anti-pattern"],
    minimumConfidence: "medium",
  });

  assert.deepEqual(result.map((item) => item.id), ["usable-method"]);
  assert.match(sql, /atom_type IN/);
  assert.match(sql, /confidence IN \('high', 'medium'\)/);
  assert.equal(bindings[0], AUTHORIZED_KNOWLEDGE_SOURCE_ID);
  assert.deepEqual(bindings.slice(1, 4), ["method", "principle", "anti-pattern"]);
});
