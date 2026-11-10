import {
  isMiniMaxTokenPlanKey,
  isMiniMaxFlashVisionConfiguration,
  parseVisionProbeMetadata,
  visionConfigurationFingerprint,
} from "./minimax-vision.ts";

export type ModelServiceStatus = {
  id: "contentGeneration" | "analysisText" | "visualUnderstanding" | "projectAssistant";
  label: string;
  configured: boolean;
  readiness: "ready" | "shared" | "pending_probe" | "failed" | "incomplete";
  stateLabel: string;
  provider: string | null;
  model: string | null;
  missing: string[];
  isolation: "independent" | "shared";
  note: string;
  keyFormatValid?: boolean;
  probeStatus?: "not_checked" | "passed" | "failed";
  probeCheckedAt?: string | null;
  probeMessage?: string | null;
  probeRequestId?: string | null;
  probeHttpStatus?: number | null;
};

type Runtime = Record<string, unknown>;
type StatusOptions = { visualProbe?: unknown };

function value(runtime: Runtime, name: string) {
  const candidate = runtime[name];
  return typeof candidate === "string" ? candidate.trim() : "";
}

function missing(runtime: Runtime, names: string[]) {
  return names.filter((name) => !value(runtime, name));
}

export function readModelServiceStatuses(runtime: Runtime, options: StatusOptions = {}) {
  const analyzerNames = ["ANALYZER_LLM_PROVIDER", "ANALYZER_LLM_BASE_URL", "ANALYZER_LLM_MODEL", "ANALYZER_LLM_API_KEY"];
  const analyzerMissing = missing(runtime, analyzerNames);
  const analysisText: ModelServiceStatus = {
    id: "analysisText",
    label: "视频分析文本模型",
    configured: analyzerMissing.length === 0,
    readiness: analyzerMissing.length === 0 ? "ready" : "incomplete",
    stateLabel: analyzerMissing.length === 0 ? "配置完整" : "等待配置",
    provider: value(runtime, "ANALYZER_LLM_PROVIDER") || null,
    model: value(runtime, "ANALYZER_LLM_MODEL") || null,
    missing: analyzerMissing,
    isolation: "independent",
    note: "负责长视频结构、亮点、语言与节奏分析。",
  };

  const contentSavedInUi = value(runtime, "CONTENT_MODEL_CONFIGURED_IN_UI") === "1";
  const contentValue = (ownName: string, fallbackName: string) => value(runtime, ownName) || (contentSavedInUi ? "" : value(runtime, fallbackName));
  const contentResolved = {
    provider: contentValue("CONTENT_MODEL_PROVIDER", "ANALYZER_LLM_PROVIDER"),
    baseUrl: contentValue("CONTENT_MODEL_BASE_URL", "ANALYZER_LLM_BASE_URL"),
    model: contentValue("CONTENT_MODEL_NAME", "ANALYZER_LLM_MODEL"),
    apiKey: contentValue("CONTENT_MODEL_API_KEY", "ANALYZER_LLM_API_KEY"),
  };
  const contentConfigured = Object.values(contentResolved).every(Boolean);
  const contentDedicated = contentSavedInUi || ["CONTENT_MODEL_PROVIDER", "CONTENT_MODEL_BASE_URL", "CONTENT_MODEL_NAME", "CONTENT_MODEL_API_KEY"]
    .every((name) => Boolean(value(runtime, name)));
  const contentGeneration: ModelServiceStatus = {
    id: "contentGeneration",
    label: "内容生成模型",
    configured: contentConfigured,
    readiness: contentConfigured ? (contentDedicated ? "ready" : "shared") : "incomplete",
    stateLabel: contentConfigured ? (contentDedicated ? "独立配置完整" : "复用分析文本模型") : "等待配置",
    provider: contentResolved.provider || null,
    model: contentResolved.model || null,
    missing: contentConfigured ? [] : [
      !contentResolved.provider ? "CONTENT_MODEL_PROVIDER / ANALYZER_LLM_PROVIDER" : "",
      !contentResolved.baseUrl ? "CONTENT_MODEL_BASE_URL / ANALYZER_LLM_BASE_URL" : "",
      !contentResolved.model ? "CONTENT_MODEL_NAME / ANALYZER_LLM_MODEL" : "",
      !contentResolved.apiKey ? "CONTENT_MODEL_API_KEY / ANALYZER_LLM_API_KEY" : "",
    ].filter(Boolean),
    isolation: contentDedicated ? "independent" : "shared",
    note: contentDedicated ? "负责内容生产，不占用视频分析模型配置。" : "当前沿用视频分析文本模型；需要时可单独填写 CONTENT_MODEL_*。",
  };

  const visionKey = value(runtime, "ANALYZER_VISION_API_KEY");
  const flashVision = isMiniMaxFlashVisionConfiguration(runtime);
  const tokenPlan = !flashVision && isMiniMaxTokenPlanKey(visionKey);
  const visionNames = ["ANALYZER_VISION_PROVIDER", "ANALYZER_VISION_BASE_URL", "ANALYZER_VISION_MODEL", "ANALYZER_VISION_API_KEY"];
  const visionMissing = missing(runtime, visionNames);
  const keyFormatValid = tokenPlan || (flashVision && Boolean(visionKey));
  const visionConfigured = tokenPlan || (flashVision && visionMissing.length === 0);
  const parsedProbe = parseVisionProbeMetadata(options.visualProbe);
  const visualProbe = parsedProbe?.fingerprint === visionConfigurationFingerprint(runtime) ? parsedProbe : null;
  const visualReadiness: ModelServiceStatus["readiness"] = !visionConfigured
    ? "incomplete"
    : visualProbe?.status === "passed"
      ? "ready"
      : visualProbe?.status === "failed"
        ? "failed"
        : "pending_probe";
  const visualUnderstanding: ModelServiceStatus = {
    id: "visualUnderstanding",
    label: "视频画面理解",
    configured: visionConfigured,
    readiness: visualReadiness,
    stateLabel: !visionConfigured
      ? flashVision ? "等待完整图片模型配置" : visionKey ? "密钥格式不兼容" : "等待图片模型配置"
      : visualProbe?.status === "passed"
        ? "真实图片预检通过"
        : visualProbe?.status === "failed"
          ? "真实图片预检失败"
          : flashVision ? "配置完整 · 待图片预检" : "密钥格式正确 · 待图片预检",
    provider: flashVision ? value(runtime, "ANALYZER_VISION_PROVIDER") || null : "MiniMax Token Plan",
    model: flashVision ? value(runtime, "ANALYZER_VISION_MODEL") || null : "understand_image（MCP）",
    missing: flashVision ? visionMissing : visionKey ? (keyFormatValid ? [] : ["ANALYZER_VISION_API_KEY（MiniMax Token Plan Key）"]) : ["ANALYZER_VISION_API_KEY"],
    isolation: "independent",
    note: flashVision
      ? visualProbe?.message || "MiniMax-M3.1-Flash 使用当前配置的密钥与 OpenAI 兼容图片接口；可用内置测试图确认实际图片能力。"
      : !keyFormatValid
        ? "旧版 MiniMax-M3 不作为视觉模型；可配置 MiniMax-M3.1-Flash 普通 API，或 MiniMax Token Plan。"
        : visualProbe?.message || "已识别 Token Plan Key；请用内置测试图确认真实图片能力。",
    keyFormatValid,
    probeStatus: visualProbe?.status || "not_checked",
    probeCheckedAt: visualProbe?.checkedAt || null,
    probeMessage: visualProbe?.message || null,
    probeRequestId: visualProbe?.requestId || null,
    probeHttpStatus: visualProbe?.httpStatus || null,
  };

  const assistantNames = [
    "PROJECT_ASSISTANT_MODEL_PROVIDER",
    "PROJECT_ASSISTANT_MODEL_BASE_URL",
    "PROJECT_ASSISTANT_MODEL_NAME",
    "PROJECT_ASSISTANT_MODEL_API_KEY",
  ];
  const assistantMissing = missing(runtime, assistantNames);
  const projectAssistant: ModelServiceStatus = {
    id: "projectAssistant",
    label: "项目记忆与灵感模型",
    configured: assistantMissing.length === 0,
    readiness: assistantMissing.length === 0 ? "ready" : "incomplete",
    stateLabel: assistantMissing.length === 0 ? "独立配置完整" : "等待配置",
    provider: value(runtime, "PROJECT_ASSISTANT_MODEL_PROVIDER") || null,
    model: value(runtime, "PROJECT_ASSISTANT_MODEL_NAME") || null,
    missing: assistantMissing,
    isolation: "independent",
    note: "专门读写项目记忆并参与灵感对话，不会回退到其他模型。",
  };

  return { contentGeneration, analysisText, visualUnderstanding, projectAssistant };
}
