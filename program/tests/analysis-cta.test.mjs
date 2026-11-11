import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("analysis v10 exposes an evidence-backed CTA contract and keeps v9 conversion compatibility", async () => {
  const provider = await readFile(
    new URL("../services/analyzer/liming_analyzer/providers.py", import.meta.url),
    "utf8",
  );

  assert.match(provider, /prompt_version: str = "video-analysis\.v10-content-v1"/);
  assert.match(provider, /"analysis\.v9"/);
  for (const field of [
    "cta_type",
    "start_ms",
    "stage",
    "evidence_text",
    "target_action",
    "handoff_path",
    "strength",
    "effectiveness",
    "recommendation",
    "overall_assessment",
    "overall_recommendation",
  ]) {
    assert.match(provider, new RegExp(`\\b${field}\\b`));
  }
  assert.match(provider, /conversion_design 继续作为旧版兼容的转化设计摘要/);
  assert.match(provider, /CTA 原话与时间码未绑定到来源证据/);
});

test("long-video and partial-output paths retain CTA analysis", async () => {
  const provider = await readFile(
    new URL("../services/analyzer/liming_analyzer/providers.py", import.meta.url),
    "utf8",
  );

  assert.match(provider, /class SegmentReport[\s\S]*?cta_analysis: CTAAnalysis/);
  assert.match(provider, /recovered_cta = _normalize_cta_analysis/);
  assert.match(provider, /"cta_analysis": recovered_cta/);
  assert.match(provider, /def _merge_cta_analysis_inputs/);
  assert.match(provider, /final_payload\.get\("segment_reports"\)/);
  assert.match(provider, /CTA 候选/);
  assert.match(provider, /"cta_validation": cta_validation/);
});
