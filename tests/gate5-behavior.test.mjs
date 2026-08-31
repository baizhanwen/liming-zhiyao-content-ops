import assert from "node:assert/strict";
import test from "node:test";
import { dedupeProjectGenerationSources, mapProjectContextSources } from "../lib/generation-source-utils.ts";

test("default project context maps only scoped authorized source types", () => {
  const mapped = mapProjectContextSources([
    { sourceType: "memory", sourceId: "memory-1", title: "客户定位", text: "服务制造业老板" },
    { sourceType: "knowledge", sourceId: "knowledge-1", title: "品牌事实", text: "提供增长咨询" },
    { sourceType: "video_atom", sourceId: "atom-1", title: "视频方法", text: "先展示损失再给方法" },
    { sourceType: "strategy", sourceId: "strategy-1", title: "当前策略", text: "聚焦高意向客户" },
    { sourceType: "inspiration", sourceId: "card-1", title: "启发", text: "只能作启发" },
    { sourceType: "memory", sourceId: null, title: "无来源", text: "不应进入" },
    { sourceType: "knowledge", sourceId: "knowledge-empty", title: "空文本", text: "   " },
  ], "org-1", "project-1");

  assert.deepEqual(mapped.map(({ sourceType, sourceId, organizationId, projectId }) => ({ sourceType, sourceId, organizationId, projectId })), [
    { sourceType: "memory", sourceId: "memory-1", organizationId: "org-1", projectId: "project-1" },
    { sourceType: "knowledge", sourceId: "knowledge-1", organizationId: "org-1", projectId: "project-1" },
    { sourceType: "video_atom", sourceId: "atom-1", organizationId: "org-1", projectId: "project-1" },
    { sourceType: "strategy", sourceId: "strategy-1", organizationId: "org-1", projectId: "project-1" },
    { sourceType: "inspiration", sourceId: "card-1", organizationId: "org-1", projectId: "project-1" },
  ]);
});

test("generation source dedupe preserves first revision but separates source types", () => {
  const sources = dedupeProjectGenerationSources([
    { sourceType: "memory", sourceId: "same-id", text: "确认记忆" },
    { sourceType: "memory", sourceId: "same-id", text: "后来的重复" },
    { sourceType: "video_atom", sourceId: "same-id", text: "视频证据" },
    { sourceType: "method_knowledge", sourceId: "method-1", text: "授权方法" },
    { sourceType: "method_knowledge", sourceId: "method-1", text: "重复方法" },
  ]);

  assert.deepEqual(sources, [
    { sourceType: "memory", sourceId: "same-id", text: "确认记忆" },
    { sourceType: "video_atom", sourceId: "same-id", text: "视频证据" },
    { sourceType: "method_knowledge", sourceId: "method-1", text: "授权方法" },
  ]);
});