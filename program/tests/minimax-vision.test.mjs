import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  normalizeMiniMaxTokenPlanHost,
  probeMiniMaxTokenPlanVision,
} from "../lib/minimax-vision.ts";

const runtime = {
  ANALYZER_VISION_PROVIDER: "minimax",
  ANALYZER_VISION_BASE_URL: "https://api.minimaxi.com/v1",
  ANALYZER_VISION_MODEL: "MiniMax-M3",
  ANALYZER_VISION_API_KEY: "sk-cp-fixture-secret",
};

test("MiniMax visual preflight uses the Token Plan VLM endpoint and returns no image response content", async () => {
  let requestUrl = "";
  let requestInit;
  const probe = await probeMiniMaxTokenPlanVision(runtime, async (input, init) => {
    requestUrl = String(input); requestInit = init;
    return new Response(JSON.stringify({ content: "图片包含蓝色矩形和红色圆形。", base_resp: { status_code: 0, status_msg: "success" } }), {
      status: 200,
      headers: { "content-type": "application/json", "trace-id": "trace-probe" },
    });
  });
  assert.equal(requestUrl, "https://api.minimaxi.com/v1/coding_plan/vlm");
  assert.equal(requestInit.method, "POST");
  assert.match(requestInit.headers.authorization, /^Bearer sk-cp-/);
  assert.match(requestInit.body, /image_url/);
  assert.equal(probe.status, "passed");
  assert.equal(probe.requestId, "trace-probe");
  assert.equal(probe.observationCount, 1);
  assert.doesNotMatch(JSON.stringify(probe), /fixture-secret|图片包含/);
  assert.equal(normalizeMiniMaxTokenPlanHost("https://malicious.invalid/v1"), "https://api.minimaxi.com");
});

test("MiniMax visual integration uses official MCP, numbered contact sheets and frame coverage diagnostics", async () => {
  const [engine, capabilities, bootstrap, provider, route, operations] = await Promise.all([
    readFile(new URL("../services/analyzer/liming_analyzer/minimax_vision.py", import.meta.url), "utf8"),
    readFile(new URL("../services/analyzer/liming_analyzer/vision_capabilities.py", import.meta.url), "utf8"),
    readFile(new URL("../services/analyzer/liming_analyzer/bootstrap.py", import.meta.url), "utf8"),
    readFile(new URL("../services/analyzer/liming_analyzer/providers.py", import.meta.url), "utf8"),
    readFile(new URL("../app/api/operations/vision-probe/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/operations/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(engine, /understand_image/);
  assert.match(engine, /image_source/);
  assert.match(engine, /minimax_mcp\.server/);
  assert.match(engine, /4 <= batch_size <= 8/);
  assert.match(engine, /vision-contact-sheets/);
  assert.match(engine, /retry_frame_count/);
  assert.match(engine, /frame_coverage_percent/);
  assert.match(engine, /request_id/);
  assert.match(engine, /provider_code/);
  assert.match(capabilities, /minimax_token_plan_mcp/);
  assert.match(capabilities, /未启用本项目的直接图片适配器/);
  assert.match(bootstrap, /MiniMaxTokenPlanMcpVisionEngine/);
  assert.match(provider, /visual_understanding_coverage/);
  assert.match(route, /model\.vision_probe/);
  assert.match(route, /VISION_PROBE_COOLDOWN/);
  assert.match(operations, /latestVisionProbe/);
});
