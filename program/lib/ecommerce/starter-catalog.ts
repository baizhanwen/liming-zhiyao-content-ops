import { z } from "zod";
import { AUTHORIZED_METHODOLOGY_ENTRIES, AUTHORIZED_METHODOLOGY_CATALOG_VERSION } from "../authorized-methodology-router";
import { componentSchema } from "./contracts";

export const ECOMMERCE_STARTER_VERSION = "2026.09.13-v1";
type Card = Omit<z.infer<typeof componentSchema>, "organizationId" | "projectId" | "id" | "revision">;
type StarterDefinition = Pick<Card, "name" | "kind" | "instruction" | "problem"> & Partial<Card> & { key: string; methodIds: string[] };
const hook = "module.content.hook-taxonomy.v1", structure = "module.content.strategy-families.v1";
const visual = "module.analysis.language-visual.v1", boundary = "rule.content.no-fabricated-claims.v1";

// Task-specific adaptations of the existing curated, authorized method catalog.
// These are production methods, not performance-proven templates or product facts.
const definitions: StarterDefinition[] = [
  { key: "scene-question", name: "使用场景提问", kind: "hook", methodIds: [hook],
    instruction: "用任务中一个具体使用场景提出问题，让观众知道接下来会演示什么；正文必须回答，不虚构用户原话。", problem: "用户不知道商品是否适合自己的使用场景" },
  { key: "barrier-first", name: "先说购买顾虑", kind: "hook", methodIds: [hook],
    instruction: "开头说清本次任务中一个购买顾虑，再指向将展示的商品证据；未确认的人群判断用条件句，不声称所有人都有此问题。", problem: "购买顾虑没有被回应" },
  { key: "action-first", name: "操作动作前置", kind: "hook", methodIds: [hook, visual],
    instruction: "第一镜直接展示已确认的商品操作动作，口播说明正在看什么，再解释适用场景；不把一次演示夸大为普遍效果。", problem: "使用过程不直观", requiredEvidenceKinds: ["demonstration"], requiredFilming: ["product", "hands"] },
  { key: "verified-offer", name: "已核实权益开头", kind: "hook", methodIds: [hook, boundary],
    instruction: "只从本任务有效价格与活动证据提取权益开头，同时交代限制与期限；不使用内部库存，不补写原价、销量或抢购理由。", problem: "价格与活动条件不清楚", requiresPrice: true, requiredEvidenceKinds: ["offer"], forbiddenConditions: ["不能提价格"] },
  { key: "hands-demo", name: "手部操作演示", kind: "visual", methodIds: [structure, visual],
    instruction: "镜头依次拍清操作前状态、关键动作和可观察结果，逐镜对应已确认的演示证据；保留使用条件，不能剪掉失败步骤后宣称一次成功。", problem: "功能说明抽象，观众看不懂怎么使用", requiredEvidenceKinds: ["demonstration"], requiredFilming: ["product", "hands"] },
  { key: "spec-detail", name: "规格与实物细节", kind: "visual", methodIds: [visual, boundary],
    instruction: "对准本商品规格所描述的实物细节，字幕只呈现有证据的规格与适用条件；不从材质或规格进一步推断功效。", problem: "商品细节和规格难以核对", requiredEvidenceKinds: ["specification"], requiredFilming: ["product"] },
  { key: "evidence-screen", name: "资料定位与画面说明", kind: "visual", methodIds: [visual, boundary],
    instruction: "拍摄或录屏展示已选证据中的确切位置，标清资料来源和适用条件；隐去无关个人信息，不把人工确认包装为实验或第三方认证。", problem: "卖点依据看不见", requiredFilming: ["screen"] },
  { key: "barrier-proof-action", name: "顾虑—证据—下一步", kind: "structure", methodIds: [structure, "rule.content.single-core.v1"],
    instruction: "围绕一个购买障碍组织：先提出顾虑，再展示一个主卖点及其证据，说明适用限制，最后给出符合任务目标的一个行动入口。", problem: "卖点堆砌，缺少回答购买障碍的主线" },
  { key: "scene-operation-action", name: "场景—操作—承接", kind: "structure", methodIds: [structure],
    instruction: "从本次真实使用场景开始，通过已确认的操作演示解释主卖点，交代适用条件，再引导到任务指定的商品卡或直播间。", problem: "商品与使用场景脱节", requiredEvidenceKinds: ["demonstration"], requiredFilming: ["product"] },
  { key: "question-explain-check", name: "问题—解释—核对", kind: "structure", methodIds: [structure, "rule.content.hook-fulfillment.v1"],
    instruction: "以一个购买问题开头，用已选商品事实及证据回答，明确哪些条件需要用户核对，再给出指定承接动作；结尾不能新增未经论证的承诺。", problem: "用户看完仍不知道下一步该核对什么" },
  { key: "evidence-shot-list", name: "逐条证据拍摄清单", kind: "sop", methodIds: [visual, "rule.analysis.claim-evidence-link.v1"],
    instruction: "将主卖点、证据位置、口播段落和镜头逐项配对，列明道具、机位、关键动作、可见细节与补拍项；仅安排任务已有拍摄条件能完成的镜头。", problem: "脚本无法落地拍摄或镜头没有证明卖点" },
  { key: "pre-shoot-check", name: "开拍前事实与承接核对", kind: "sop", methodIds: ["rule.content.plan-before-draft.v1", boundary],
    instruction: "开拍前核对 SKU 与证据版本、道具和拍摄条件、字幕事实与限制、实际承接入口；列清待人工确认事项，缺证据的镜头先补资料。", problem: "拍摄后才发现事实、条件或入口不匹配" },
];

export const ECOMMERCE_STARTER_CARDS = definitions.map(({ key, methodIds, ...definition }) => {
  const methods = methodIds.map(id => {
    const method = AUTHORIZED_METHODOLOGY_ENTRIES.find(m => m.id === id);
    if (!method) throw new Error(`Missing authorized methodology: ${id}`);
    return { id: method.id, version: method.version, source: method.source };
  });
  const parsed = componentSchema.omit({ organizationId: true, projectId: true, id: true, revision: true }).parse({
    platforms: ["douyin", "wechat_channels", "xiaohongshu", "other"], targets: ["product_click", "live_entry", "purchase"],
    inputContract: "本次人群、场景、购买障碍、一个已确认主卖点及证据、拍摄条件与承接目标。",
    outputContract: "本组件对应段落或镜头、适配理由、来源原句与稿件片段；不能充当商品事实来源。",
    sourceLocator: methods.map(m => `${m.source.package}/${m.source.document}#${m.id}`).join("\n"),
    sourceVersion: `${ECOMMERCE_STARTER_VERSION}; catalog=${AUTHORIZED_METHODOLOGY_CATALOG_VERSION}; ${methods.map(m => `${m.id}@${m.version}`).join("; ")}`,
    authorization: "源自项目现有授权方法目录，电商适配仅用于当前空间的结构和拍摄指导；未经真实投放或成交验证。",
    status: "confirmed", ...definition,
  });
  return { key, methods, card: parsed };
});
