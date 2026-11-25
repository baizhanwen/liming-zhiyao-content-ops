import type { ProjectAssistantDatabase } from "./project-memory-events.ts";

export const accountSubjects = ["个人", "搭档或团队", "门店或品牌", "学校或机构", "栏目或虚构角色", "其他"];
export const publicationChoices = ["可以公开", "匿名后可公开", "只供内部参考", "待确认"] as const;
export const materialNatures = ["本人亲历", "他人原话", "团队归纳", "官方事实", "个人观点", "虚构或改编", "待核对"];
export const materialUses = ["事实依据", "直接引语", "画面或原声", "仅参考风格"];
export const evidenceTypes = ["本人经验", "官方说明", "操作或实拍", "采访或客户反馈", "项目记录", "其他"];
export const materialTypes = {
  experience: { label: "经历、人物与访谈", category: "founder", questions: ["谁在什么场景经历了什么？", "哪一句是原话，哪些是转述？", "可以核对哪个片段？"] },
  tutorial: { label: "知识、教程与观点", category: "other", questions: ["想讲清哪个问题或观点？", "有哪些依据、步骤或例子？", "怎样判断做对了，什么时候适用？"] },
  review: { label: "测评、探店与对比", category: "other", questions: ["体验或比较了哪些对象？", "在什么条件下比较哪些方面？", "实际观察到什么，哪些来自产品说明？"] },
  fiction: { label: "剧情、段子与虚构角色", category: "other", questions: ["有哪些角色、人物关系或系列设定？", "哪些情节是虚构或改编？", "哪些桥段或台词可以复用？"] },
  footage: { label: "作品、画面与原声", category: "high_performing_copy", questions: ["片段里能看到或听到什么？", "从哪个时间点到哪个时间点？", "适合上屏、原声，还是参考写法？"] },
  product: { label: "产品与服务", category: "other", questions: ["谁在什么场景用这个产品或服务？", "怎样使用或交付，能看到什么？", "与什么做法有何差别，有哪些限制？"] },
  question: { label: "观众或客户的问题", category: "customer_question", questions: ["对方具体怎么问，或你想验证什么？", "提问发生在什么场景？", "目前能给什么回答或演示？"] },
  case: { label: "真实案例", category: "case_study", questions: ["谁遇到了什么具体问题？", "谁做了哪些关键动作？", "结果怎样，哪些仍在跟踪？"] },
} as const;
export type MaterialKind = keyof typeof materialTypes;
export type KnowledgeAnswers = Record<string, string>;
export type KnowledgeForm = { kind: MaterialKind | "profile"; answers: KnowledgeAnswers };

const profileKeys = ["accountName", "subject", "background", "sample", "sampleUse", "boundary"];
const materialKeys = ["title", "answer0", "answer1", "answer2", "nature", "usage", "evidenceType", "source", "publication", "publicSummary", "metric", "basis", "review"];

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function checkedAnswers(value: unknown, keys: string[], limit: number): Record<string, string> {
  if (!record(value)) throw Error("请重新打开表单后填写。");
  const data: Record<string, string> = {};
  for (const key of keys) {
    const field = value[key];
    if (field === undefined || field === "") continue;
    if (typeof field !== "string" || field.trim().length > limit) throw Error("填写内容过长，请缩短后保存。");
    if (field.trim()) data[key] = field.trim();
  }
  return data;
}
function lines(entries: Array<[string, string | undefined]>) {
  return entries.filter(([, value]) => value).map(([label, value]) => label + "：" + value).join("\n");
}

export function projectKnowledgeForm(input: unknown) {
  if (!record(input) || typeof input.kind !== "string" || (input.kind !== "profile" && !Object.hasOwn(materialTypes, input.kind))) throw Error("资料类型无效。");
  const kind = input.kind as KnowledgeForm["kind"];
  const a = checkedAnswers(input.answers, kind === "profile" ? profileKeys : materialKeys, 1500);
  const form: KnowledgeForm = { kind, answers: a };
  if (kind === "profile") {
    if (!a.accountName || a.accountName.length > 100 || !a.subject) throw Error("请填写发布名称，并选择账号主体。");
    const body = lines([["发布名称", a.accountName], ["账号主体", a.subject], ["可长期公开的背景", a.background], ["代表作品", a.sample], ["参考用途", a.sampleUse], ["长期公开边界", a.boundary]]);
    return { form, title: a.accountName + " · 账号资料", category: "brand_story", body, sourceType: "manual", sourceRef: null };
  }
  const type = materialTypes[kind];
  if (!a.answer0) throw Error("请先填写这条材料的第一个问题。");
  if (!publicationChoices.some(choice => choice === a.publication)) throw Error("请选择这条材料的公开范围。");
  if (a.publication === "匿名后可公开" && !a.publicSummary) throw Error("请填写已去除识别信息的公开摘要。");
  if (a.title && a.title.length > 120) throw Error("材料标题最多 120 字。");
  if (a.metric && (!a.basis || !a.source)) throw Error("量化说法需要填写统计口径或比较基准，以及可核对的来源。");
  if (a.review && !/^\d{4}-\d{2}-\d{2}$/.test(a.review)) throw Error("请填写有效的复核日期。");
  const publishable = a.publication === "可以公开";
  const title = publishable ? a.title || a.answer0.slice(0, 60) : type.label + " · " + a.publication;
  const content = publishable
    ? type.questions.map((q, i): [string, string] => [q, a["answer" + i]])
    : [["允许公开的摘要", a.publication === "匿名后可公开" ? a.publicSummary : ""]] as Array<[string, string]>;
  const nature = a.nature || (kind === "fiction" ? "虚构或改编" : "");
  const safeUse = (a.usage || "").split("、").filter(value => materialUses.includes(value)).join("、");
  const body = lines([
    ["材料类型", type.label], ["公开范围", a.publication], ...content,
    ["资料性质", publishable || materialNatures.includes(nature) ? nature : ""], ["允许用途", publishable ? a.usage : safeUse],
    ["来源类型", publishable || evidenceTypes.includes(a.evidenceType) ? a.evidenceType : ""], ["可复核的数字", publishable ? a.metric : ""], ["统计口径或比较基准", publishable ? a.basis : ""], ["复核日期", a.review],
  ]);
  return { form, title: title.length > 1 ? title : type.label + " · " + title, category: type.category, body, sourceType: "manual", sourceRef: null };
}

export function canConfirmKnowledgeForm(form: KnowledgeForm | null | undefined) {
  return !form || form.kind === "profile" || form.answers.publication === "可以公开" || form.answers.publication === "匿名后可公开";
}

export async function readAccountDisclosureBoundaries(db: ProjectAssistantDatabase, scope: { organizationId: string; projectId: string }): Promise<string[]> {
  // Project only the confirmed public rule. The rest of the account profile remains opt-in material.
  const { results } = await db.prepare(`
    SELECT DISTINCT trim(json_extract(v.form_json, '$.answers.boundary')) AS boundary
    FROM knowledge_items k
    JOIN knowledge_item_versions v ON v.organization_id = k.organization_id AND v.project_id = k.project_id
      AND v.item_id = k.id AND v.version = k.current_version
    WHERE k.organization_id = ? AND k.project_id = ? AND k.status = 'confirmed' AND k.deleted_at IS NULL
      AND json_extract(v.form_json, '$.kind') = 'profile'
      AND json_type(v.form_json, '$.answers.boundary') = 'text'
      AND trim(json_extract(v.form_json, '$.answers.boundary')) != ''
    ORDER BY boundary
  `).bind(scope.organizationId, scope.projectId).all<{ boundary: string }>();
  return results.map(row => row.boundary);
}

export const strategyOptions = {
  audience: ["同经历的人", "同兴趣的人", "初学者", "已有经验的人", "正在做选择的人", "还在探索"],
  formats: ["生活 Vlog", "过程或挑战", "人物纪实", "访谈", "科普", "教程", "测评或探店", "观点", "资讯或活动", "剧情", "才艺或竞技", "氛围", "解说或切片", "商品或服务"],
  goal: ["陪伴或共鸣", "娱乐或审美", "启发思考", "学会方法", "获得信息", "帮助选择", "认识品牌", "建立信任", "咨询或购买"],
  presentation: ["对镜头说", "访谈对话", "后配旁白", "字幕日记", "录屏演示", "角色表演", "音乐或环境声"],
  deliverables: ["口播", "旁白", "字幕", "采访提纲", "角色对白", "镜头或选段顺序", "上屏表", "发布配文", "按本条决定"],
  narrator: ["本人", "团队", "旁观者", "受访者原声", "固定虚构角色", "无固定讲述者"],
  tone: ["自然聊天", "同学分享", "老师演示", "专业分析", "幽默", "克制"],
  ending: ["按本条决定", "自然结束", "保留原声", "给建议", "上屏清单", "下期预告", "评论交流", "资料领取", "咨询或购买"],
};

export type StrategyAnswers = Record<string, string>;
const strategyKeys = [...Object.keys(strategyOptions), "audienceDetail", "themes", "preferences", "series", "name", "positioning", "painPoints", "conversionPath", "legacyStyle", "legacyPersona", "cadence"];
export function projectStrategyForm(input: unknown) {
  const a = checkedAnswers(input, strategyKeys, 2000);
  if (!a.audience && !a.audienceDetail) throw Error("请选择或填写这一阶段的观众。");
  if (!a.themes || !a.goal) throw Error("请填写长期主题，并选择本阶段的首要目标。");
  const pillars = a.themes.split(/[，,、\n]/).map(s => s.trim()).filter(Boolean);
  if (pillars.length > 20 || pillars.some(s => s.length > 100)) throw Error("最多填写 20 个主题，每项不超过 100 字。");
  if (!pillars.length) throw Error("请填写至少一个具体主题。");
  const targetAudience = [a.audience, a.audienceDetail].filter(Boolean).join(" · ");
  const positioning = a.positioning || lines([["长期主题", a.themes], ["常做的视频", a.formats]]);
  const styleNotes = lines([["常做的视频", a.formats], ["呈现方式", a.presentation], ["常用成品", a.deliverables], ["表达视角", a.narrator], ["语气", a.tone], ["保留或避开的表达", a.preferences], ["常用收尾", a.ending], ["栏目要求", a.series], ["既有风格", a.legacyStyle]]);
  if (styleNotes.length > 2000 || positioning.length > 2000 || targetAudience.length > 1000 || a.goal.length > 200) throw Error("策略内容超过字段长度，请缩短后保存。");
  return {
    form: a, name: a.name || a.themes.slice(0, 60) + " · 内容策略", positioning,
    persona: a.legacyPersona || a.narrator, targetAudience, painPoints: (a.painPoints || "").split(/[，,、\n]/).map(s => s.trim()).filter(Boolean),
    pillars, objectives: [a.goal], styleNotes, cadence: a.cadence, conversionPath: a.conversionPath,
  };
}
