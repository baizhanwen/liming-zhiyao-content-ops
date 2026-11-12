import type { EcommerceContext } from "./context";
import { ECOMMERCE_METHODOLOGY_CATALOG, ECOMMERCE_METHODOLOGY_VERSION, ecommerceCategoryMethod, ecommerceMethodCandidates, getMethodologySelection, type MethodologySelection, type MethodSource } from "./methodology-catalog.ts";

export { methodologySelectionIssues, getMethodologySelection } from "./methodology-catalog.ts";
export type { MethodologySelection } from "./methodology-catalog.ts";
export const ECOMMERCE_COPY_METHODOLOGY_VERSION = ECOMMERCE_METHODOLOGY_VERSION;

/** Freeze exact, task-relevant source paragraphs into every model stage. */
export function buildEcommerceCopyMethodology(context: EcommerceContext, selection?: MethodologySelection | null) {
  const { brief } = context.input.task, { product } = context.input;
  const benchmark = brief.referenceMode === "benchmark";
  const candidates = ecommerceMethodCandidates(context), selected = getMethodologySelection(context, selection);
  const cardsReady = context.input.candidates.some(item => item.card.kind === "hook") && context.input.candidates.some(item => item.card.kind === "structure");
  const category = ecommerceCategoryMethod(context);
  const activeHooks = benchmark ? [] : selected ? [selected.hook] : candidates.hooks;
  const activeFrameworks = benchmark ? [] : selected ? [selected.framework, ...selected.supplement ? [selected.supplement] : []] : candidates.frameworks;
  const materialRules = ECOMMERCE_METHODOLOGY_CATALOG.materialRules;
  const excerptSources: MethodSource[] = [
    ...activeHooks.map(item => item.source), ...activeFrameworks.map(item => item.source),
    ...category ? [category.source] : [], ...[materialRules[0], materialRules[1], materialRules[2], materialRules[3]],
  ];
  const sourceExcerpts = excerptSources.filter((source, index, values) => values.findIndex(item => item.document === source.document && item.line === source.line) === index);
  const simpleProduct = product.claim.id.startsWith("product-claim:");
  return {
    version: ECOMMERCE_COPY_METHODOLOGY_VERSION,
    catalogDigest: ECOMMERCE_METHODOLOGY_CATALOG.sourceDigest,
    coverage: ECOMMERCE_METHODOLOGY_CATALOG.coverage,
    sources: sourceExcerpts.map(({ document: path, section, sha256, line }) => ({ path, section, sha256, line })),
    sourceExcerpts,
    scope: "原文段落只作为写法和结构参考。它们的示例、测试数字、效果、背书、稀缺和承诺不是本商品事实；不允许把方法中的素材写成商品经历。原文风险表达按本次事实边界改写。",
    mode: benchmark ? "benchmark" : "method",
    structureAuthority: benchmark
      ? { source: "selected_benchmark", ids: context.input.cases.map(item => item.id), rule: "保留唯一所选参考的段落功能和推进机制，用本商品细节独立重写；不要额外套一套方法框架。" }
      : cardsReady
        ? { source: "selected_method_cards", ids: brief.componentIds, rule: "方法卡限定开头和主结构；仍须从本次方法候选选择能落地的具体推进步骤，不能只报策略族名称。" }
        : { source: "builtin_methodology", ids: selected ? [selected.hook.id, selected.framework.id, ...selected.supplement ? [selected.supplement.id] : []] : [], rule: "无需参考视频或额外方法卡，选择本次候选中的一个钩子和一个主框架，按该框架的beats组织一条完整口播；不要把所有候选拼进一稿。" },
    methodCandidates: { hooks: activeHooks, frameworks: activeFrameworks },
    selectedMethods: selected,
    materials: {
      audience: { user: brief.audience.user, buyer: brief.audience.buyer, situation: brief.audience.situation, status: brief.audience.status },
      purchaseBarrier: brief.barrier, scene: brief.scene,
      firstSellingPoint: { claimId: product.claim.id, allowedExpression: product.claim.allowedExpression, conditions: product.claim.conditions,
        rule: simpleProduct ? "围绕一个真实且具体的商品差异形成购买理由；录入卖点仅是表达重点，不能证明功效、销量、资质或保证。不能用商品名称、品类或‘规格1’冒充卖点。" : "一个主卖点，用已有具体内容、使用例子、交付或机制解释为什么值得选择，其他事实只为它服务。" },
      emotion: { status: "creative_hypothesis", rule: "共鸣来自本次具体处境，不推断人群实际情绪，不编亲身经历或用户原话。" },
      action: { target: brief.target, destination: brief.destination, rule: "一个指定承接动作，说明观众下一步能了解什么，不新增私信评论关注。" },
    },
    hookGuidance: { timing: "前3–5秒给具体问题、反向观点或有依据的信息差；5–10秒落到一个主卖点。不要写‘想提升自己但不知道适不适合’这种适用于任何商品的泛问句。",
      candidates: activeHooks.map(item => ({ id: item.id, name: item.name, condition: `${item.definition}；${item.risk}${item.id === "hook.offer" ? `；对应有效权益证据：${context.input.evidence.filter(e => e.kind === "offer").map(e => e.id).join("、")}` : ""}` })),
      limits: "钩子要在正文兑现。可以有鲜明观点、条件式提问和真实取舍；不能冒充测评者、虚构买过多门课或未经证实的结果。" },
    strategyGuidance: { maxPrimary: 1, maxSupplement: 1,
      familyIndex: benchmark ? [] : ECOMMERCE_METHODOLOGY_CATALOG.frameworks.map(item => `${item.name}（${item.familyRange}）`),
      candidates: activeFrameworks,
      rule: "所选框架的每个beat必须映射到实际段落；一个段落可覆盖相邻两步。最后一步给适用条件与行动，不堆砌卖点，不重复开头。" },
    categoryMethod: category,
    planDirection: {
      hook: "先比较几种切入角度，选最能连接任务顾虑与商品真实差异的一种，给出具体开头观点。",
      bridge: "围绕 sellingPointFocus，把观点接到真实场景和具体产品机制，说明选择依据。",
      proof: "找出至少两条能支撑选择的具体事实；用例子、步骤、内容或交付细节解释，不读数据库字段。",
      cta: "给出真实适用限制或取舍，再引导到指定位置了解与本次主张有关的具体内容。",
      referenceAdaptation: benchmark ? "说明参考机制与本商品事实如何对应，不迁移参考的身份、价格或结果。" : "无参考时留空；methodSelection记录具体hookId/frameworkId及与本任务对应的理由。",
    },
    writingRules: [
      "先建立一个明确、有依据的选择观点，再用具体场景和细节证明；正文应让观众知道这个商品具体提供什么、解决哪一步问题、为什么值得了解。",
      "卖点不是形容词。把‘便宜/实用/专业’拆为已有事实支持的成本、内容、机制、交付或取舍；没有事实就报告缺口，不把抽象词扩成承诺。",
      "每个核心段落增加新的具体信息，不用‘看看是否适合自己/核对基础信息/这是一款某某’反复填字。",
      "用自然短句和长短变化写成能直接念的口播。后台分类、规格字段、资料标注、已确认、录入价格、来源核查与免责声明只留在依据报告，不能读进正文。",
      "允许有观点、取舍和不适用条件，避免全程夸赞；真实限制来自用户提供的资料，不能编缺点来假装客观。",
      "第一人称购买、试用、耗时、对比和反馈必须有本商品的明确事实来源；不得从参考稿或方法示例借来。",
      "交付一条闭环完整文案；缺关键资料时应明确补什么，不生成带【待填】的假成稿。只写文案，不加镜头表或拍摄清单。",
    ],
    reviewChecklist: [
      "开头有没有一个具体观点或信息差，换成任何其他商品是否仍成立？泛泛适配提问不能算合格钩子。",
      "正文是否用本商品的具体内容、使用例子、机制或交付回应同一个购买顾虑，至少提供两条非重复选择信息？",
      "每个methodBeat是否在对应script中真正落实，还是只在计划中报方法名？",
      "是否出现数据库字段、公关腔、空话复述、商品名称解释自身、没有内容的价格说明？",
      "观点、细节、证明、真实取舍与行动是否连贯，结尾是否给出值得执行指定动作的理由？",
      "每句经历、数值、效果、优惠和对比是否被所选商品事实支持，方法案例和参考事实是否被错误迁移？",
    ],
    qualityChecks: { hookFulfilled: "钩子的具体问题或观点在正文中得到事实回应。", singleFocus: "只证明一个清楚的购买理由。", spokenNatural: "像在给一个具体的人讲选择理由，读得出、有信息，不念字段或审计说明。", ctaClear: "指定动作清楚，观众知道下一步看什么。", referenceAdapted: benchmark ? "迁移唯一参考的推进机制而非事实和原句。" : "用实际段落执行所选原文方法，methodBeat与正文内容一致。" },
  };
}
