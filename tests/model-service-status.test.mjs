import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readModelServiceStatuses } from "../lib/model-service-status.ts";
import { visionConfigurationFingerprint } from "../lib/minimax-vision.ts";

const runtime = {
  ANALYZER_LLM_PROVIDER: "deepseek",
  ANALYZER_LLM_BASE_URL: "https://api.deepseek.com/v1",
  ANALYZER_LLM_MODEL: "deepseek-chat",
  ANALYZER_LLM_API_KEY: "analysis-secret",
  ANALYZER_VISION_PROVIDER: "minimax",
  ANALYZER_VISION_BASE_URL: "https://api.minimaxi.com/v1",
  ANALYZER_VISION_MODEL: "MiniMax-M3",
  ANALYZER_VISION_API_KEY: "sk-cp-token-plan-secret",
  PROJECT_ASSISTANT_MODEL_PROVIDER: "minimax",
  PROJECT_ASSISTANT_MODEL_BASE_URL: "https://api.minimaxi.com/v1",
  PROJECT_ASSISTANT_MODEL_NAME: "MiniMax-M2.1",
  PROJECT_ASSISTANT_MODEL_API_KEY: "assistant-secret",
};

function probe(status) {
  return {
    status,
    checkedAt: "2026-08-25T04:00:00.000Z",
    fingerprint: visionConfigurationFingerprint(runtime),
    provider: "MiniMax Token Plan",
    model: "understand_image",
    adapter: "understand_image_api_preflight",
    endpointConnected: status === "passed",
    imageTestPassed: status === "passed",
    observationCount: status === "passed" ? 1 : 0,
    httpStatus: status === "passed" ? 200 : 401,
    responseType: "application/json",
    requestId: "trace-fixture",
    providerCode: status === "passed" ? 0 : 1004,
    message: status === "passed" ? "图片预检通过。" : "鉴权失败。",
  };
}

test("system model status separates four model responsibilities without exposing secrets", () => {
  const status = readModelServiceStatuses(runtime);
  assert.deepEqual(Object.keys(status), [
    "contentGeneration",
    "analysisText",
    "visualUnderstanding",
    "projectAssistant",
  ]);
  assert.equal(status.contentGeneration.configured, true);
  assert.equal(status.contentGeneration.readiness, "shared");
  assert.equal(status.analysisText.readiness, "ready");
  assert.equal(status.visualUnderstanding.configured, true);
  assert.equal(status.visualUnderstanding.model, "understand_image（MCP）");
  assert.equal(status.visualUnderstanding.readiness, "pending_probe");
  assert.equal(status.visualUnderstanding.probeStatus, "not_checked");
  assert.equal(status.projectAssistant.isolation, "independent");
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /analysis-secret|token-plan-secret|assistant-secret/);
});

test("visual status records passed, failed and stale probe states separately", () => {
  const passed = readModelServiceStatuses(runtime, { visualProbe: probe("passed") });
  assert.equal(passed.visualUnderstanding.readiness, "ready");
  assert.equal(passed.visualUnderstanding.probeStatus, "passed");
  assert.equal(passed.visualUnderstanding.probeRequestId, "trace-fixture");

  const failed = readModelServiceStatuses(runtime, { visualProbe: probe("failed") });
  assert.equal(failed.visualUnderstanding.readiness, "failed");
  assert.equal(failed.visualUnderstanding.probeHttpStatus, 401);
  assert.match(failed.visualUnderstanding.stateLabel, /失败/);

  const stale = { ...probe("passed"), fingerprint: "old-config" };
  const pending = readModelServiceStatuses(runtime, { visualProbe: stale });
  assert.equal(pending.visualUnderstanding.readiness, "pending_probe");
  assert.equal(pending.visualUnderstanding.probeStatus, "not_checked");
});

test("visual status rejects ordinary chat keys and the settings UI names all four chains", () => {
  const status = readModelServiceStatuses({ ANALYZER_VISION_API_KEY: "ordinary-chat-key" });
  assert.equal(status.visualUnderstanding.configured, false);
  assert.equal(status.visualUnderstanding.keyFormatValid, false);
  assert.match(status.visualUnderstanding.stateLabel, /不兼容/);

  const ui = readFileSync(new URL("../components/SystemOperations.tsx", import.meta.url), "utf8");
  assert.match(ui, /四类模型链路/);
  assert.match(ui, /contentGeneration/);
  assert.match(ui, /analysisText/);
  assert.match(ui, /visualUnderstanding/);
  assert.match(ui, /projectAssistant/);
  assert.match(ui, /测试真实图片能力/);
  assert.match(ui, /operations\/vision-probe/);
});
