/**
 * Curated, deterministic methodology routing.
 *
 * This catalog intentionally contains only reusable process rules. Customer
 * facts, example claims, copied scripts and unversioned platform assertions
 * are excluded. The selected plan can therefore guide an LLM, but can never
 * be used as evidence for a factual claim about a customer or a video.
 */

export type AuthorizedMethodTask = "topic" | "content" | "analysis";
export type AuthorizedMethodPlatform = "generic" | "douyin" | "xiaohongshu" | "wechat" | "kuaishou";
export type AuthorizedMethodMode = "standard" | "complete-script" | "benchmark-structure" | "hook-testing" | "published-performance";
export type AuthorizedMethodKind = "core_playbook" | "module" | "rule";
export type AuthorizedMethodStage = "routing" | "planning" | "hook" | "structure" | "drafting" | "evidence" | "diagnosis" | "verification";
export type AuthorizedMethodRisk = "low" | "medium" | "high";

export type AuthorizedMethodSource = Readonly<{
  package: "03_Skill库" | "data" | "dbskill" | "project-curation";
  document: string;
  revision: string;
  note: string;
}>;

export type AuthorizedMethodologyEntry = Readonly<{
  id: string;
  kind: AuthorizedMethodKind;
  title: string;
  task: AuthorizedMethodTask | "all";
  platform: AuthorizedMethodPlatform | "all";
  stage: AuthorizedMethodStage;
  mode: AuthorizedMethodMode | "all";
  risk: AuthorizedMethodRisk;
  source: AuthorizedMethodSource;
  version: string;
  requiredEvidence: readonly string[];
  instruction: string;
  keywords: readonly string[];
  priority: number;
}>;

export const AUTHORIZED_METHODOLOGY_CATALOG_VERSION = "2026.08.28-v1";

const SKILL_SOURCE = {
  package: "03_Skill库",
  document: "01_生产型Skill/短视频内容生产Skill/duanshipin-neirong-shengchan.md",
  revision: "2026-05-28",
  note: "仅采用模式路由、资料边界和生产流程；排除客户假设、路径配置和成品样例。",
} as const;

const COMPLIANCE_SOURCE = {
  package: "03_Skill库",
  document: "03_检查型Skill/事实与合规检查Skill.md",
  revision: "2026-04-28",
  note: "仅采用来源优先级、四态资料边界和发布前门禁；具体平台规则需另行核验版本。",
} as const;

const HOOK_SOURCE = {
  package: "data",
  document: "短视频创作方法/全域素材破局/全域素材破局_18种钩子类型.md",
  revision: "2026-04-28-curated",
  note: "仅保留钩子分类；剔除虚假身份、功效暗示、虚假稀缺和无依据背书。",
} as const;

const FRAMEWORK_SOURCE = {
  package: "data",
  document: "短视频创作方法/全域素材破局/全域素材破局_100种素材框架.md",
  revision: "2026-04-28-curated",
  note: "仅保留十个策略族的结构用途；删除效果承诺、焦虑放大和未核实案例。",
} as const;

const AUTHORIZED_SOURCE = {
  package: "dbskill",
  document: "知识库/Skill知识包 + skills/dbs-*（清洗映射）",
  revision: "d18f556332bdbcf13a87bf61e531f7207d676b74",
  note: "仅采用可复用的单一核心、开头、逻辑延续与共鸣诊断方法；排除个人立场和案例事实。",
} as const;

const CURATED_SOURCE = {
  package: "project-curation",
  document: "授权方法分层与视频证据规范",
  revision: AUTHORIZED_METHODOLOGY_CATALOG_VERSION,
  note: "由已授权方法、项目现有证据门禁与导入包审计结果合并形成。",
} as const;

export const CONTENT_STRATEGY_FAMILIES = [
  { id: "explicit-pain", name: "显性痛点攻坚", use: "从受众已明确感知的问题切入，再给出有依据的解决路径。" },
  { id: "latent-need", name: "隐性需求发现", use: "从真实场景发现未被说清的需求，不制造恐惧。" },
  { id: "identity-trust", name: "真实身份信任", use: "只使用可核验的身份、经历或资质建立信任。" },
  { id: "demonstration", name: "真实实测验证", use: "用可复现画面或数据展示过程，保留条件和限制。" },
  { id: "source-trace", name: "来源与过程呈现", use: "展示真实生产、服务或交付过程，不虚构源头与标准。" },
  { id: "emotional-resonance", name: "情绪共鸣引导", use: "说清受众处境和立场，不利用羞耻、恐惧或歧视施压。" },
  { id: "timely-scene", name: "时令场景连接", use: "连接真实节日、季节或使用时机，不编造热点。" },
  { id: "verified-offer", name: "已核实权益转化", use: "仅呈现当前有效且有依据的价格、权益、库存和期限。" },
  { id: "curiosity-reveal", name: "悬念与揭示", use: "延迟答案但不隐瞒关键条件，正文必须兑现开头承诺。" },
  { id: "comparison-explanation", name: "解释型对比", use: "比较可验证维度，说明适用差异，不贬损竞品。" },
] as const;

export const CONTENT_HOOK_TYPES = [
  "点名受众", "直击痛点", "真实身份", "对话冲突", "提出疑问", "开箱评测",
  "过程探访", "实验演示", "情绪共鸣", "结果前置", "对比呈现", "悬念好奇",
  "反向表达", "时令热点", "已核实权益", "行业解释", "真实问答", "借物类比",
] as const;

export const ANALYSIS_RUBRIC_DIMENSIONS = [
  { id: "source-coverage", name: "来源覆盖", evidence: "ASR/OCR/关键帧覆盖范围及缺口" },
  { id: "hook-promise", name: "开头与承诺", evidence: "前3-5秒时间码、逐字稿和对应画面" },
  { id: "single-claim", name: "核心主张", evidence: "主张首次出现及论证段落时间码" },
  { id: "structure-flow", name: "结构与延续", evidence: "段落边界、转折点、重复或跳跃片段" },
  { id: "spoken-language", name: "语言与口播", evidence: "对应逐字稿、长句、术语和断句位置" },
  { id: "visual-expression", name: "画面表达", evidence: "关键帧、OCR、画面变化点及声画关系" },
  { id: "resonance", name: "受众与共鸣", evidence: "具体措辞、立场、情绪推进及受众线索" },
  { id: "conversion", name: "转化设计", evidence: "CTA、权益或承诺原文及其事实来源" },
  { id: "performance", name: "表现数据", evidence: "明确标注来源和采集时间的公开或企业后台指标" },
] as const;

function entry(value: AuthorizedMethodologyEntry) { return value; }

export const AUTHORIZED_METHODOLOGY_ENTRIES: readonly AuthorizedMethodologyEntry[] = [
  entry({
    id: "playbook.topic.evidence-led.v1", kind: "core_playbook", title: "证据约束的选题规划", task: "topic", platform: "all", stage: "routing", mode: "all", risk: "medium",
    source: SKILL_SOURCE, version: "1.0.0", requiredEvidence: ["企业空间内已确认的受众、业务或内容策略", "用户本次明确输入"],
    instruction: "先确定目标受众、一个核心问题和看完后的认知或行动，再选择内容角度；没有企业依据的字段应留空或标记待确认。",
    keywords: ["选题", "方向", "受众", "栏目", "角度"], priority: 100,
  }),
  entry({
    id: "playbook.content.three-mode.v1", kind: "core_playbook", title: "短视频三模式生产", task: "content", platform: "all", stage: "routing", mode: "all", risk: "medium",
    source: SKILL_SOURCE, version: "1.0.0", requiredEvidence: ["当前企业空间资料", "用户本次任务", "若采用对标则需提供对标来源"],
    instruction: "按完整脚本、对标结构学习、钩子测试三种模式分流；依次完成资料约束、结构选择、钩子设计、成稿和发布前校验。默认先生成文案，不在未要求时扩写完整分镜。",
    keywords: ["文案", "口播", "脚本", "仿写", "钩子", "短视频"], priority: 100,
  }),
  entry({
    id: "playbook.analysis.evidence-first.v1", kind: "core_playbook", title: "证据优先的视频诊断", task: "analysis", platform: "all", stage: "routing", mode: "all", risk: "high",
    source: CURATED_SOURCE, version: "1.0.0", requiredEvidence: ["带时间码的ASR逐字稿", "带时间点的关键帧或OCR", "指标来源与采集时间（如涉及数据）"],
    instruction: "先说明素材覆盖范围，再按观察、方法判断、可复用建议三层输出；视频事实必须来自时间码、逐字稿、画面或数据快照，方法论只能解释证据，不能替代证据。",
    keywords: ["视频分析", "诊断", "拆解", "证据", "关键帧", "逐字稿"], priority: 100,
  }),

  entry({
    id: "module.topic.audience-objective.v1", kind: "module", title: "受众处境与内容目标", task: "topic", platform: "all", stage: "planning", mode: "all", risk: "low",
    source: AUTHORIZED_SOURCE, version: "1.0.0", requiredEvidence: ["目标受众及其具体处境", "本次业务目标"],
    instruction: "受众写具体处境、需求、顾虑和认知水平；目标写看完后的认知变化或行动，不写宽泛人群标签。",
    keywords: ["受众", "人群", "获客", "曝光", "成交", "目标"], priority: 80,
  }),
  entry({
    id: "module.topic.evidence-potential.v1", kind: "module", title: "可兑现性评估", task: "topic", platform: "all", stage: "planning", mode: "all", risk: "medium",
    source: COMPLIANCE_SOURCE, version: "1.0.0", requiredEvidence: ["可用于正文的观点、事实、案例或画面素材清单"],
    instruction: "生成选题前检查正文是否有材料兑现开头；素材不足时降低承诺强度或输出待补资料，不用夸张标题掩盖空内容。",
    keywords: ["事实", "案例", "数据", "素材", "依据", "兑现"], priority: 75,
  }),
  entry({
    id: "module.content.strategy-families.v1", kind: "module", title: "十类内容策略族", task: "content", platform: "all", stage: "structure", mode: "all", risk: "medium",
    source: FRAMEWORK_SOURCE, version: "1.0.0", requiredEvidence: ["与所选策略对应的真实痛点、过程、权益、比较维度或场景"],
    instruction: `从十类策略中只选择最符合任务证据的一类作为主结构：${CONTENT_STRATEGY_FAMILIES.map((item) => `${item.name}（${item.use}）`).join("；")}。`,
    keywords: ["结构", "策略", "框架", "卖点", "痛点", "转化", "故事"], priority: 78,
  }),
  entry({
    id: "module.content.hook-taxonomy.v1", kind: "module", title: "十八类安全钩子", task: "content", platform: "all", stage: "hook", mode: "all", risk: "medium",
    source: HOOK_SOURCE, version: "1.0.0", requiredEvidence: ["正文中可兑现的主题和信息", "身份、结果、价格、数据或热点的独立依据（如使用）"],
    instruction: `从以下钩子类型选择与正文证据匹配的一类：${CONTENT_HOOK_TYPES.join("、")}。钩子须在3-5秒内说明话题和继续观看理由；身份、结果、价格、库存、问答及热点不得虚构。`,
    keywords: ["钩子", "开头", "前3秒", "前 3 秒", "停留", "标题"], priority: 82,
  }),
  entry({
    id: "module.content.benchmark-boundary.v1", kind: "module", title: "对标结构学习", task: "content", platform: "all", stage: "structure", mode: "benchmark-structure", risk: "high",
    source: COMPLIANCE_SOURCE, version: "1.0.0", requiredEvidence: ["对标原文或视频来源", "当前企业自己的事实与案例"],
    instruction: "只抽取钩子机制、段落功能、节奏、情绪推进和转化设计；重新设计论证路径，不迁移原句、独特表达、案例、数据、品牌、价格或承诺。",
    keywords: ["对标", "爆款", "仿写", "参考", "结构", "同构"], priority: 96,
  }),
  entry({
    id: "module.content.benchmark-boundary.v2", kind: "module", title: "对标结构学习", task: "content", platform: "all", stage: "structure", mode: "benchmark-structure", risk: "high",
    source: COMPLIANCE_SOURCE, version: "1.1.0", requiredEvidence: ["对标原文或视频来源", "客户事实来自自己的资料；外部内容须有来源依据与归属"],
    instruction: "沿用钩子机制、段落功能、节奏、情绪推进和转化设计的参考逻辑，不强制逐条正向采用写法。对已选 benchmark，可按相关性与价值选择性借鉴有依据的问题、观点、解释、方法或外部案例；保留外部归属和适用范围，不擅自扩题。重新组织表达，不搬运原句或独特表达，不把外部案例、数据、品牌、价格或承诺冒充当前企业事实。",
    keywords: ["对标", "爆款", "仿写", "参考", "结构", "同构"], priority: 96,
  }),
  entry({
    id: "module.content.script-flow.v1", kind: "module", title: "逻辑延续与口播检查", task: "content", platform: "all", stage: "drafting", mode: "complete-script", risk: "low",
    source: AUTHORIZED_SOURCE, version: "1.0.0", requiredEvidence: ["完整逐字稿或段落草稿"],
    instruction: "逐段检查逻辑衔接、信息密度和口播流畅度；补齐必要过渡，删除重复，长句拆分，术语后立即用大白话解释。",
    keywords: ["口播", "逐字稿", "顺", "逻辑", "断句", "长句"], priority: 74,
  }),
  entry({
    id: "module.analysis.full-rubric.v1", kind: "module", title: "视频九维诊断量表", task: "analysis", platform: "all", stage: "diagnosis", mode: "all", risk: "high",
    source: CURATED_SOURCE, version: "1.0.0", requiredEvidence: ANALYSIS_RUBRIC_DIMENSIONS.map((item) => `${item.name}：${item.evidence}`),
    instruction: `根据素材覆盖选择适用维度，不为缺失维度编造结论：${ANALYSIS_RUBRIC_DIMENSIONS.map((item) => `${item.name}（${item.evidence}）`).join("；")}。`,
    keywords: ["全面", "结构", "语言", "画面", "共鸣", "转化", "数据", "表现", "复盘"], priority: 110,
  }),
  entry({
    id: "module.analysis.hook-structure.v1", kind: "module", title: "开头、主张与结构诊断", task: "analysis", platform: "all", stage: "diagnosis", mode: "all", risk: "medium",
    source: AUTHORIZED_SOURCE, version: "1.0.0", requiredEvidence: ["前5秒逐字稿与关键帧", "核心主张及支撑段落时间码", "开头承诺与正文兑现位置"],
    instruction: "检查开头能否独立交代话题、观看理由和可信依据，是否保留合理悬念；再判断全文是否围绕一个核心主张展开、段落功能是否连续。",
    keywords: ["开头", "钩子", "结构", "主张", "悬念", "完播"], priority: 84,
  }),
  entry({
    id: "module.analysis.language-visual.v1", kind: "module", title: "语言、节奏与画面诊断", task: "analysis", platform: "all", stage: "diagnosis", mode: "all", risk: "medium",
    source: CURATED_SOURCE, version: "1.0.0", requiredEvidence: ["对应逐字稿时间码", "关键帧/OCR及画面变化时间点"],
    instruction: "分别检查口播可理解性、信息密度、段落过渡，以及画面是否补充或证明口播；不得仅凭封面推断整条视频的视觉表现。",
    keywords: ["语言", "口播", "节奏", "画面", "关键帧", "ocr", "视觉"], priority: 80,
  }),
  entry({
    id: "module.analysis.resonance-conversion.v1", kind: "module", title: "受众共鸣与转化诊断", task: "analysis", platform: "all", stage: "diagnosis", mode: "all", risk: "medium",
    source: AUTHORIZED_SOURCE, version: "1.0.0", requiredEvidence: ["受众指向、立场、情绪和CTA的原文时间码", "权益或效果表达的事实来源"],
    instruction: "判断内容说出了谁的何种处境、站在谁的立场、满足何种需要以及CTA是否自然承接；只解释文本机制，不预测播放量或把相关性写成因果。",
    keywords: ["受众", "共鸣", "情绪", "转化", "cta", "互动", "传播"], priority: 78,
  }),

  entry({
    id: "rule.topic.no-invented-premise.v1", kind: "rule", title: "选题不得虚构前提", task: "topic", platform: "all", stage: "verification", mode: "all", risk: "high",
    source: COMPLIANCE_SOURCE, version: "1.0.0", requiredEvidence: ["企业资料或用户明确输入"], instruction: "不得为选题补写不存在的客户成绩、产品能力、案例、数据、资质或受众结论；缺失时标记待确认。", keywords: ["事实", "成绩", "案例", "数据"], priority: 100,
  }),
  entry({
    id: "rule.topic.one-objective.v1", kind: "rule", title: "一个选题一个目标", task: "topic", platform: "all", stage: "verification", mode: "all", risk: "low",
    source: AUTHORIZED_SOURCE, version: "1.0.0", requiredEvidence: ["明确的内容目标"], instruction: "一个选题只保留一个主要认知或行动目标，其他信息必须服务该目标。", keywords: ["目标", "主张", "选题"], priority: 92,
  }),
  entry({
    id: "rule.topic.no-performance-prediction.v1", kind: "rule", title: "不预测平台结果", task: "topic", platform: "all", stage: "verification", mode: "all", risk: "medium",
    source: AUTHORIZED_SOURCE, version: "1.0.0", requiredEvidence: ["无；此项为禁止性规则"], instruction: "不得把方法匹配写成必爆、播放量或转化率预测；只能说明内容假设及验证指标。", keywords: ["爆款", "播放", "流量", "预测"], priority: 88,
  }),
  entry({
    id: "rule.topic.audience-specific.v1", kind: "rule", title: "受众必须具体", task: "topic", platform: "all", stage: "verification", mode: "all", risk: "low",
    source: AUTHORIZED_SOURCE, version: "1.0.0", requiredEvidence: ["用户画像或本次明确受众"], instruction: "受众须写服务谁、当前处境、核心需求或顾虑，不能只写老板、年轻人等宽泛标签。", keywords: ["受众", "用户", "人群"], priority: 86,
  }),
  entry({
    id: "rule.content.source-boundary.v1", kind: "rule", title: "事实与方法分离", task: "content", platform: "all", stage: "verification", mode: "all", risk: "high",
    source: COMPLIANCE_SOURCE, version: "1.0.0", requiredEvidence: ["客户事实来自企业资料或用户确认", "方法来源仅用于结构与表达"], instruction: "方法库、对标、案例和历史成品只能指导结构，不能成为当前企业事实；所有事实性表达必须能追溯到当前输入。", keywords: ["事实", "来源", "资料", "方法"], priority: 110,
  }),
  entry({
    id: "rule.content.source-boundary.v2", kind: "rule", title: "事实与方法分离", task: "content", platform: "all", stage: "verification", mode: "all", risk: "high",
    source: COMPLIANCE_SOURCE, version: "1.1.0", requiredEvidence: ["客户事实来自企业资料或用户确认", "方法来源仅用于结构与表达", "借鉴的 benchmark 内容须有来源依据与外部归属"], instruction: "方法库、历史成品和灵感仅指导写法；已选 benchmark 还可选择性提供相关问题、观点、解释、方法或有归属的外部案例，但都不能成为当前企业事实。所有事实性表达必须能追溯到当前输入；不得把外部经历写成作者亲历或把来源观点升级为已验证的普遍事实。", keywords: ["事实", "来源", "资料", "方法"], priority: 110,
  }),
  entry({
    id: "rule.content.single-core.v1", kind: "rule", title: "单一核心主张", task: "content", platform: "all", stage: "verification", mode: "all", risk: "low",
    source: AUTHORIZED_SOURCE, version: "1.0.0", requiredEvidence: ["一句话核心主张", "各段对核心主张的支撑关系"], instruction: "一条内容只保留一个核心主张；其他观点只能作为解释、证据、案例或方案。", keywords: ["核心", "主张", "卖点", "观点"], priority: 100,
  }),
  entry({
    id: "rule.content.no-fabricated-claims.v1", kind: "rule", title: "禁止编造高风险信息", task: "content", platform: "all", stage: "verification", mode: "all", risk: "high",
    source: COMPLIANCE_SOURCE, version: "1.0.0", requiredEvidence: ["价格、活动、库存、功效、收益、数据、排名、身份、资质和案例的独立依据"], instruction: "不得编造或合理化补全价格、活动、库存、功效、收益、数据、排名、身份、资质和案例；免责声明不能让无依据主张变得可用。", keywords: ["价格", "活动", "功效", "收益", "数据", "身份"], priority: 108,
  }),
  entry({
    id: "rule.content.no-copying.v1", kind: "rule", title: "对标不搬运", task: "content", platform: "all", stage: "verification", mode: "all", risk: "high",
    source: COMPLIANCE_SOURCE, version: "1.0.0", requiredEvidence: ["对标来源", "独立重组后的论证结构", "当前企业自己的事实"], instruction: "不得整句复制、同义替换洗稿或迁移对标的案例、数据与独特表达；存在历史成品时也必须重新组织表达。", keywords: ["对标", "仿写", "历史", "复制", "同构"], priority: 98,
  }),
  entry({
    id: "rule.content.no-copying.v2", kind: "rule", title: "对标不搬运", task: "content", platform: "all", stage: "verification", mode: "all", risk: "high",
    source: COMPLIANCE_SOURCE, version: "1.1.0", requiredEvidence: ["对标来源", "独立重组后的论证结构", "当前企业自己的事实"], instruction: "不得整句复制、同义替换洗稿或搬运独特表达；选择性借鉴已选 benchmark 的内容时，必须独立组织表达，外部案例和数据保留归属，不得冒充作者亲历。存在历史成品时仍只学习结构并重新组织表达。", keywords: ["对标", "仿写", "历史", "复制", "同构"], priority: 98,
  }),
  entry({
    id: "rule.content.hook-fulfillment.v1", kind: "rule", title: "开头承诺必须兑现", task: "content", platform: "all", stage: "verification", mode: "all", risk: "medium",
    source: AUTHORIZED_SOURCE, version: "1.0.0", requiredEvidence: ["钩子中的承诺", "正文对应的兑现段落"], instruction: "开头必须脱离标题独立成立，且正文逐项兑现开头承诺；没有可信依据时降低承诺强度。", keywords: ["开头", "钩子", "兑现", "悬念"], priority: 96,
  }),
  entry({
    id: "rule.content.plan-before-draft.v1", kind: "rule", title: "先方案后成稿", task: "content", platform: "all", stage: "planning", mode: "all", risk: "low",
    source: SKILL_SOURCE, version: "1.0.0", requiredEvidence: ["内容目标、受众、第一卖点、结构和钩子选择"], instruction: "先生成可审计的创作方案，再依据方案成稿；不要让模型一边补事实一边自由扩写。", keywords: ["方案", "计划", "结构", "生成"], priority: 90,
  }),
  entry({
    id: "rule.content.platform-rules-versioned.v1", kind: "rule", title: "平台规则需版本化", task: "content", platform: "all", stage: "verification", mode: "all", risk: "high",
    source: CURATED_SOURCE, version: "1.0.0", requiredEvidence: ["带来源与核验日期的平台规则"], instruction: "平台合规判断必须使用带来源和日期的现行规则；导入包中的通用规则只能触发风险复核，不能作为现行平台政策证明。", keywords: ["平台", "合规", "抖音", "小红书", "视频号"], priority: 94,
  }),
  entry({
    id: "rule.analysis.claim-evidence-link.v1", kind: "rule", title: "结论逐条绑定证据", task: "analysis", platform: "all", stage: "evidence", mode: "all", risk: "high",
    source: CURATED_SOURCE, version: "1.0.0", requiredEvidence: ["每条结论对应的时间码", "逐字稿片段、OCR或关键帧引用"], instruction: "每条关于钩子、语言、画面、结构和转化的结论都要绑定时间码及证据片段，不能只给总体印象。", keywords: ["证据", "时间码", "片段", "关键帧"], priority: 112,
  }),
  entry({
    id: "rule.analysis.coverage-before-conclusion.v1", kind: "rule", title: "先报告覆盖再下结论", task: "analysis", platform: "all", stage: "evidence", mode: "all", risk: "high",
    source: CURATED_SOURCE, version: "1.0.0", requiredEvidence: ["视频时长", "ASR覆盖区间", "关键帧/OCR覆盖区间及缺失"], instruction: "分析前先报告音频、画面和指标覆盖；未覆盖的部分不得按已分析处理。", keywords: ["完整", "覆盖", "缺失", "asr", "关键帧"], priority: 108,
  }),
  entry({
    id: "rule.analysis.separate-layers.v1", kind: "rule", title: "观察、解释、建议分层", task: "analysis", platform: "all", stage: "verification", mode: "all", risk: "medium",
    source: CURATED_SOURCE, version: "1.0.0", requiredEvidence: ["观察层引用视频证据", "解释层引用方法ID"], instruction: "明确区分视频中实际发生了什么、使用何种方法解释、在何种条件下可复用；不得把建议写成视频事实。", keywords: ["观察", "判断", "建议", "方法"], priority: 104,
  }),
  entry({
    id: "rule.analysis.method-is-not-evidence.v1", kind: "rule", title: "方法论不能替代视频证据", task: "analysis", platform: "all", stage: "verification", mode: "all", risk: "high",
    source: CURATED_SOURCE, version: "1.0.0", requiredEvidence: ["方法ID", "独立的视频证据引用"], instruction: "授权方法用于选择分析维度和解释证据，不能证明视频中存在某种效果、情绪、意图或因果。", keywords: ["方法", "证据", "意图", "因果"], priority: 106,
  }),
  entry({
    id: "rule.analysis.missing-evidence-downgrade.v1", kind: "rule", title: "证据不足则降级", task: "analysis", platform: "all", stage: "verification", mode: "all", risk: "high",
    source: COMPLIANCE_SOURCE, version: "1.0.0", requiredEvidence: ["缺失证据列表", "可支持的最小结论范围"], instruction: "缺少时间码、完整转写、关键帧或数据来源时，结论必须标记待确认、不可判断或条件性建议，不得补猜。", keywords: ["缺失", "待确认", "不可判断", "降级"], priority: 110,
  }),
  entry({
    id: "rule.analysis.metric-provenance.v1", kind: "rule", title: "指标标注来源与时点", task: "analysis", platform: "all", stage: "evidence", mode: "published-performance", risk: "high",
    source: CURATED_SOURCE, version: "1.0.0", requiredEvidence: ["公开页面或企业后台来源", "采集时间", "指标口径"], instruction: "公开互动和企业后台指标分开展示并保留采集时间；零值、缺失值和不可获取值不能混为一类，也不能用当前快照推断完整增量。", keywords: ["指标", "播放", "互动", "后台", "完播", "增量"], priority: 114,
  }),
  entry({
    id: "rule.analysis.no-causal-overreach.v1", kind: "rule", title: "不把相关性写成因果", task: "analysis", platform: "all", stage: "verification", mode: "all", risk: "medium",
    source: AUTHORIZED_SOURCE, version: "1.0.0", requiredEvidence: ["跨作品或跨周期对照（若要主张因果）"], instruction: "单条视频只能提出结构假设和相关线索；没有对照或多周期验证时，不得断言某个钩子、画面或话术导致了表现。", keywords: ["原因", "导致", "爆款", "表现", "因果"], priority: 96,
  }),
];

export type AvailableMethodSource = string | Readonly<{
  id?: unknown;
  sourceId?: unknown;
  sourceType?: unknown;
  title?: unknown;
}>;

export type SelectAuthorizedMethodologyPlanInput = Readonly<{
  task: AuthorizedMethodTask;
  query: string;
  platform?: string;
  mode?: string;
  availableMethodSources?: readonly AvailableMethodSource[];
  hasBenchmarks?: boolean;
  hasHistoricalCopies?: boolean;
  maxModules?: number;
  maxRules?: number;
}>;

export type AuthorizedMethodologySnapshot = Readonly<{
  schemaVersion: 1;
  catalogVersion: string;
  planId: string;
  task: AuthorizedMethodTask;
  platform: AuthorizedMethodPlatform;
  mode: AuthorizedMethodMode;
  selectedIds: readonly string[];
  sourceRevisions: readonly string[];
  availableMethodSourceIds: readonly string[];
  hasBenchmarks: boolean;
  hasHistoricalCopies: boolean;
}>;

export type AuthorizedMethodologyPlan = Readonly<{
  id: string;
  version: string;
  task: AuthorizedMethodTask;
  platform: AuthorizedMethodPlatform;
  mode: AuthorizedMethodMode;
  selectedIds: readonly string[];
  corePlaybook: AuthorizedMethodologyEntry;
  modules: readonly AuthorizedMethodologyEntry[];
  rules: readonly AuthorizedMethodologyEntry[];
  snapshot: AuthorizedMethodologySnapshot;
}>;

export type AuthorizedMethodologyApplication = Readonly<{
  planId: string;
  planVersion: string;
  mode: string;
  selectedMethodIds: readonly string[];
}>;

type ParsedAuthorizedMethodologyPlanId = Readonly<{
  task: AuthorizedMethodTask;
  platform: AuthorizedMethodPlatform;
  mode: AuthorizedMethodMode;
}>;

function normalizeText(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizePlatform(value: string | undefined, query: string): AuthorizedMethodPlatform {
  const text = normalizeText(`${value ?? ""} ${query}`);
  if (/抖音|douyin|千川/.test(text)) return "douyin";
  if (/小红书|xiaohongshu|rednote/.test(text)) return "xiaohongshu";
  if (/视频号|公众号|微信|wechat/.test(text)) return "wechat";
  if (/快手|kuaishou/.test(text)) return "kuaishou";
  return "generic";
}

function normalizeMode(task: AuthorizedMethodTask, value: string | undefined, query: string): AuthorizedMethodMode {
  const explicit = normalizeText(value ?? "");
  const text = explicit || normalizeText(query);
  if (/benchmark|对标|爆款结构|仿写|同构|参考结构/.test(text)) return "benchmark-structure";
  if (/hook|钩子|前\s*[35三五]\s*秒|投流|千川|开头测试/.test(text)) return "hook-testing";
  if (task === "analysis" && /published|已发布|后台数据|数据表现|完播|互动|播放|增量|复盘/.test(text)) return "published-performance";
  if (/complete-script|完整脚本|完整文案|口播稿|逐字稿/.test(text)) return "complete-script";
  if (explicit === "standard" || explicit === "标准") return "standard";
  return task === "content" ? "complete-script" : "standard";
}

function methodSourceId(source: AvailableMethodSource, index: number) {
  if (typeof source === "string") return source.trim().slice(0, 160);
  for (const value of [source.sourceId, source.id, source.title]) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 160);
  }
  return `method-source-${index + 1}`;
}

function entryApplies(entryValue: AuthorizedMethodologyEntry, task: AuthorizedMethodTask, platform: AuthorizedMethodPlatform, mode: AuthorizedMethodMode) {
  return (entryValue.task === "all" || entryValue.task === task)
    && (entryValue.platform === "all" || entryValue.platform === platform)
    && (entryValue.mode === "all" || entryValue.mode === mode);
}

function scoreEntry(entryValue: AuthorizedMethodologyEntry, query: string, input: SelectAuthorizedMethodologyPlanInput) {
  let score = entryValue.priority;
  const text = normalizeText(query);
  for (const keyword of entryValue.keywords) if (text.includes(normalizeText(keyword))) score += 12 + Math.min(8, keyword.length);
  if (entryValue.platform !== "all") score += 5;
  if (entryValue.mode !== "all") score += 8;
  if (input.hasBenchmarks && /benchmark|对标|仿写/.test(entryValue.id)) score += 42;
  if (input.hasHistoricalCopies && /no-copying|benchmark/.test(entryValue.id)) score += 32;
  if ((input.availableMethodSources?.length ?? 0) > 0 && entryValue.source.package === "dbskill") score += 3;
  return score;
}

function sourceRevision(entryValue: AuthorizedMethodologyEntry) {
  return `${entryValue.source.package}:${entryValue.source.revision}`;
}

/**
 * Select one core playbook, one or two specialist modules and three to six
 * gates. The function is deterministic: equal inputs always produce an equal
 * plan and snapshot, which makes the plan safe to persist with a generation.
 */
export function selectAuthorizedMethodologyPlan(input: SelectAuthorizedMethodologyPlanInput): AuthorizedMethodologyPlan {
  const query = input.query ?? "";
  const platform = normalizePlatform(input.platform, query);
  const mode = normalizeMode(input.task, input.mode, query);
  // Keep v1 text available for citations on saved packs. Only selected benchmark
  // generation uses v2; the existing path without benchmarks remains unchanged.
  const benchmarkRevisions = ["module.content.benchmark-boundary", "rule.content.source-boundary", "rule.content.no-copying"];
  const useBenchmarkContent = input.task === "content" && (input.hasBenchmarks || mode === "benchmark-structure");
  const excludedRevision = useBenchmarkContent ? "v1" : "v2";
  const candidates = AUTHORIZED_METHODOLOGY_ENTRIES.filter((item) => entryApplies(item, input.task, platform, mode)
    && !benchmarkRevisions.some((id) => item.id === `${id}.${excludedRevision}`));
  const ranked = (kind: AuthorizedMethodKind) => candidates
    .filter((item) => item.kind === kind)
    .map((item) => ({ item, score: scoreEntry(item, query, input) }))
    .sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id))
    .map(({ item }) => item);

  const corePlaybook = ranked("core_playbook")[0];
  if (!corePlaybook) throw new Error(`No authorized core methodology for task: ${input.task}`);
  const moduleLimit = Math.max(1, Math.min(2, Math.trunc(input.maxModules ?? 2)));
  const ruleLimit = Math.max(3, Math.min(6, Math.trunc(input.maxRules ?? 5)));
  const modules = ranked("module").slice(0, moduleLimit);
  const rules = ranked("rule").slice(0, ruleLimit);
  if (!modules.length || rules.length < 3) throw new Error(`Incomplete authorized methodology catalog for task: ${input.task}`);

  const selectedIds = [corePlaybook.id, ...modules.map((item) => item.id), ...rules.map((item) => item.id)];
  const id = `methodology.${input.task}.${platform}.${mode}.${AUTHORIZED_METHODOLOGY_CATALOG_VERSION}`;
  const availableMethodSourceIds = [...new Set((input.availableMethodSources ?? []).map(methodSourceId).filter(Boolean))].slice(0, 20);
  const sourceRevisions = [...new Set([corePlaybook, ...modules, ...rules].map(sourceRevision))].sort();
  const snapshot: AuthorizedMethodologySnapshot = {
    schemaVersion: 1,
    catalogVersion: AUTHORIZED_METHODOLOGY_CATALOG_VERSION,
    planId: id,
    task: input.task,
    platform,
    mode,
    selectedIds,
    sourceRevisions,
    availableMethodSourceIds,
    hasBenchmarks: Boolean(input.hasBenchmarks),
    hasHistoricalCopies: Boolean(input.hasHistoricalCopies),
  };
  return { id, version: AUTHORIZED_METHODOLOGY_CATALOG_VERSION, task: input.task, platform, mode, selectedIds, corePlaybook, modules, rules, snapshot };
}

function parseAuthorizedMethodologyPlanId(value: string): ParsedAuthorizedMethodologyPlanId | null {
  const prefix = "methodology.";
  const suffix = `.${AUTHORIZED_METHODOLOGY_CATALOG_VERSION}`;
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return null;
  const scope = value.slice(prefix.length, -suffix.length).split(".");
  if (scope.length !== 3) return null;
  const [task, platform, mode] = scope;
  if (!["topic", "content", "analysis"].includes(task)) return null;
  if (!["generic", "douyin", "xiaohongshu", "wechat", "kuaishou"].includes(platform)) return null;
  if (!["standard", "complete-script", "benchmark-structure", "hook-testing", "published-performance"].includes(mode)) return null;
  const parsed = { task, platform, mode } as ParsedAuthorizedMethodologyPlanId;
  const deterministicPlan = selectAuthorizedMethodologyPlan({ task: parsed.task, platform: parsed.platform, mode: parsed.mode, query: "" });
  return deterministicPlan.id === value ? parsed : null;
}

/**
 * Rebuild the exact prompt source recorded on a generated content pack.
 *
 * A plan id alone is not sufficient because query scoring can select different
 * modules and gates inside the same task/platform/mode. The server-authored
 * selected method ids are therefore required and checked against the current,
 * versioned catalog before their text is accepted as a citation source.
 */
export function authorizedMethodologyApplicationPromptSource(application: AuthorizedMethodologyApplication) {
  const parsed = parseAuthorizedMethodologyPlanId(application.planId);
  if (!parsed || application.planVersion !== AUTHORIZED_METHODOLOGY_CATALOG_VERSION || application.mode !== parsed.mode) return null;
  const selectedIds = [...application.selectedMethodIds];
  if (selectedIds.length < 5 || selectedIds.length > 9 || new Set(selectedIds).size !== selectedIds.length) return null;
  const catalogById = new Map(AUTHORIZED_METHODOLOGY_ENTRIES.map((item) => [item.id, item]));
  const selectedEntries = selectedIds.map((id) => catalogById.get(id));
  if (selectedEntries.some((item) => !item)) return null;
  const entries = selectedEntries as AuthorizedMethodologyEntry[];
  if (entries.some((item) => !entryApplies(item, parsed.task, parsed.platform, parsed.mode))) return null;

  const corePlaybooks = entries.filter((item) => item.kind === "core_playbook");
  const modules = entries.filter((item) => item.kind === "module");
  const rules = entries.filter((item) => item.kind === "rule");
  if (corePlaybooks.length !== 1 || modules.length < 1 || modules.length > 2 || rules.length < 3 || rules.length > 6) return null;
  const orderedIds = [corePlaybooks[0].id, ...modules.map((item) => item.id), ...rules.map((item) => item.id)];
  if (orderedIds.some((id, index) => id !== selectedIds[index])) return null;
  const deterministicCore = selectAuthorizedMethodologyPlan({ task: parsed.task, platform: parsed.platform, mode: parsed.mode, query: "" }).corePlaybook;
  if (corePlaybooks[0].id !== deterministicCore.id) return null;

  const sourceRevisions = [...new Set(entries.map(sourceRevision))].sort();
  const plan: AuthorizedMethodologyPlan = {
    id: application.planId,
    version: AUTHORIZED_METHODOLOGY_CATALOG_VERSION,
    task: parsed.task,
    platform: parsed.platform,
    mode: parsed.mode,
    selectedIds,
    corePlaybook: corePlaybooks[0],
    modules,
    rules,
    snapshot: {
      schemaVersion: 1,
      catalogVersion: AUTHORIZED_METHODOLOGY_CATALOG_VERSION,
      planId: application.planId,
      task: parsed.task,
      platform: parsed.platform,
      mode: parsed.mode,
      selectedIds,
      sourceRevisions,
      availableMethodSourceIds: [],
      hasBenchmarks: parsed.mode === "benchmark-structure",
      hasHistoricalCopies: false,
    },
  };
  return methodologyPlanPromptSource(plan);
}

function promptEntry(item: AuthorizedMethodologyEntry, index?: number) {
  const heading = index === undefined ? item.title : `${index + 1}. ${item.title}`;
  return [
    `${heading} [${item.id}@${item.version}]`,
    `执行：${item.instruction}`,
    `证据要求：${item.requiredEvidence.join("；")}`,
  ].join("\n");
}

/** Serialize only curated instructions; raw source examples are never copied. */
export function methodologyPlanPromptSource(plan: AuthorizedMethodologyPlan) {
  return [
    `授权方法执行计划 [${plan.id}]`,
    `目录版本：${plan.version}；任务：${plan.task}；平台：${plan.platform}；模式：${plan.mode}`,
    "边界：以下内容只规定如何创作或分析，不是客户事实、视频事实或现行平台政策。事实必须来自本次已授权资料；证据不足时标记待确认，不得补猜。",
    "",
    "核心流程：",
    promptEntry(plan.corePlaybook),
    "",
    "本次方法模块：",
    ...plan.modules.map((item, index) => promptEntry(item, index)),
    "",
    "强制门禁：",
    ...plan.rules.map((item, index) => promptEntry(item, index)),
    "",
    `方法快照ID：${plan.selectedIds.join(", ")}`,
  ].join("\n");
}
