import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const library = await import("../lib/script-rewrite.ts");

test("rewrite units preserve source order and stay inside bounded model batches", () => {
  const text = Array.from({ length: 19 }, (_, index) => `第${index + 1}段需要保留的完整信息和具体表达。`).join("\n\n");
  const units = library.buildScriptUnits(text);
  const batches = library.batchScriptUnits(units, 200, 8);
  assert.equal(units.length, 19);
  assert.deepEqual(units.map((item) => item.paragraphId).slice(0, 2), ["p-0001", "p-0002"]);
  assert.ok(batches.every((batch) => batch.length <= 8));
  assert.deepEqual(batches.flat().map((item) => item.paragraphId), units.map((item) => item.paragraphId));
});

test("no selected rewrite means zero calls while each requested variant has an explicit estimate", () => {
  const source = "这是一段需要改写的企业口播内容。".repeat(80);
  assert.equal(library.estimateRewriteUsage(source, []).callCount, 0);
  assert.equal(library.estimateRewriteUsage(source, ["light_rewrite"]).callCount, 2);
  assert.equal(library.estimateRewriteUsage(source, ["light_rewrite"]).maximumCallCount, 6);
  assert.equal(library.estimateRewriteUsage(source, ["restructured"]).callCount, 4);
  assert.equal(library.estimateRewriteUsage(source, ["restructured"]).maximumCallCount, 16);
  assert.equal(
    library.estimateRewriteUsage(source, ["light_rewrite", "restructured"]).callCount,
    library.estimateRewriteUsage(source, ["light_rewrite"]).callCount + 4,
  );
});

test("long micro rewrites estimate one body call per controlled batch", () => {
  const source = Array.from({ length: 4 }, (_, index) => `第${index + 1}段，${"需要保留完整观点、案例和推导过程。".repeat(80)}`).join("\n\n");
  const units = library.buildScriptUnits(source, library.SCRIPT_REWRITE_MAX_CHARACTERS);
  const batches = library.batchScriptUnits(units, library.SCRIPT_REWRITE_MICRO_BATCH_CHARACTERS, library.SCRIPT_REWRITE_MICRO_BATCH_UNITS);
  const estimate = library.estimateRewriteUsage(source, ["light_rewrite"]);
  assert.ok(batches.length > 1);
  assert.equal(estimate.callCount, batches.length + 1);
  assert.equal(estimate.maximumCallCount, batches.length * 3 + 3);
});

test("Chinese and Arabic numeral spellings compare by value for equivalent reconstruction", () => {
  const source = "成功率百分之五，一百个人尝试三年；一九八七年他四十三岁，用二点一万起步，曾损失两百多万。";
  const candidate = "成功率5%，100个人尝试3年；1987年他43岁，用2.1万起步，曾损失200多万。";
  assert.deepEqual(library.semanticRewriteFacts(candidate), library.semanticRewriteFacts(source));
});

test("spoken ratios and idioms preserve 5% and 100% without requiring literal percent signs", () => {
  const source = "成功率5%，每100个人3年后只剩5个；只有1颗子弹，命中率必须100%。";
  const candidate = "每100个人，3年后还能活着的只有5个；只有一颗子弹时必须百发百中。";
  assert.deepEqual(library.semanticRewriteFacts(candidate), library.semanticRewriteFacts(source));
});

test("a fuzzy ten-wan amount does not invent a second standalone ten-thousand fact", () => {
  const source = "他手里只有十几万块钱，只够进行一次完整尝试。";
  const ledger = "普通人拿十几万开店，资金只允许完成一次尝试。";
  assert.deepEqual(library.semanticRewriteFacts(ledger), library.semanticRewriteFacts(source));
  assert.doesNotMatch(library.semanticRewriteFacts(source).join("|"), /(?:^|\|)10000(?:\||$)/u);
});

test("modal qian-wan phrases do not invent a protected numeric fact", () => {
  const facts = library.semanticRewriteFacts("一个爆款千万不要只讲一遍，千万别把提醒误当成数字。");
  assert.deepEqual(facts, []);
  assert.doesNotMatch(facts.join("|"), /(?:^|\|)1000(?:\||$)/u);
});

test("colloquial one-or-two ge counts are not hard facts while material counts remain protected", () => {
  const facts = library.semanticRewriteFacts("一个爆款可以把两个角度重新组合，这二十个选题要保留；三个人试四次，预算五万元。");
  assert.doesNotMatch(facts.join("|"), /(?:^|\|)(?:1|2)(?:\||$)/u);
  assert.ok(facts.includes("20"));
  assert.ok(facts.includes("3"));
  assert.ok(facts.includes("4"));
  assert.ok(facts.includes("50000"));
});

test("adjacent Chinese digits before a classifier are an approximate range rather than twenty-three", () => {
  assert.deepEqual(library.semanticRewriteFacts("可以同时试两三个方向"), library.semanticRewriteFacts("可以同时试两到三个方向"));
  assert.doesNotMatch(library.semanticRewriteFacts("可以同时试两三个方向").join("|"), /(?:^|\|)23(?:\||$)/u);
});

test("production timecodes may move while real performance numbers stay protected", () => {
  const facts = library.immutableRewriteFacts("【0-3秒】开场，00:19切镜头；5秒完播率41.16%，2027年目标提升7.1%。");
  assert.doesNotMatch(facts.join("|"), /(?:^|\|)(?:0|3|00|19)(?:\||$)/);
  assert.deepEqual(facts, ["2027", "41.16%", "5", "7.1%"]);
});

test("light rewrite requires exact mapping, immutable facts and visible lexical changes", () => {
  const units = library.buildScriptUnits("因为企业在2027年要让AI增长7.1%，所以必须先记录真实数据。\n\n然后团队每天复盘结果，最后再决定下一步怎么调整。");
  const copied = library.validateLightRewrite(units, units.map((item) => ({ paragraphId: item.paragraphId, text: item.text })));
  assert.equal(copied.passed, false);
  assert.equal(copied.checks.find((item) => item.key === "effective_change")?.passed, false);
  const rewritten = library.validateLightRewrite(units, [
    { paragraphId: "p-0001", text: "由于企业在2027年要让AI增长7.1%，因此务必先记录真实数据。" },
    { paragraphId: "p-0002", text: "接着团队每天复盘结果，最终再决定下一步如何调整。" },
  ]);
  assert.equal(rewritten.passed, true);
  assert.deepEqual(rewritten.missingImmutableFacts, []);
  const wrongMapping = library.validateLightRewrite(units, [
    { paragraphId: "p-0002", text: units[0].text },
    { paragraphId: "p-0001", text: units[1].text },
  ]);
  assert.equal(wrongMapping.checks.find((item) => item.key === "mapping")?.passed, false);
  const inventedNumber = library.validateLightRewrite(units, [
    { paragraphId: "p-0001", text: "企业要在2027年推动AI增长7.1%，因此应先把真实数据记清楚。" },
    { paragraphId: "p-0002", text: "团队每天回看结果，再安排下一步调整，并保证30天完成。" },
  ]);
  assert.equal(inventedNumber.checks.find((item) => item.key === "no_new_facts")?.passed, false);
});

test("light rewrite accepts a common protected acronym expanded to the same meaning", () => {
  const units = library.buildScriptUnits("工作流就是把优秀员工的做法固化成SOP，方便新人照着执行并持续复盘。");
  const validation = library.validateLightRewrite(units, [{
    paragraphId: "p-0001",
    text: "工作流要把成熟员工的经验整理成标准操作流程，让新人能够按步骤落实并反复检查。",
  }]);
  assert.equal(validation.checks.find((item) => item.key === "facts")?.passed, true);
  assert.deepEqual(validation.missingImmutableFacts, []);
});

test("a semantically complete micro draft survives a minor length warning for review", () => {
  const source = [
    "第三个，知识库，就是入职培训资料。新员工进来，你得把公司产品、客户话术、常见问题整理给他看，他才能上手。AI也一样，你得把公司散落的资料整理好，它才能用得上。关键是资料先整理，不然AI也是巧妇难为无米之炊。",
    "第四个，智能体，就是能独立干活的新员工。它不是万能助手，是有明确边界和审核的数字员工。你给它定岗位说明书，告诉它能做什么、不能做什么、做完谁来检查。就像你给新员工定职责，不能让他什么都干，也不能让他乱干。",
    "第五个，工作流，就是把优秀员工的做法固化成SOP。你公司里肯定有干得好的老员工，他的经验能不能沉淀下来，变成新人也能照做的流程？工作流就是干这个的。把一次成功做法固定成可复用的流程，比提示词值钱。",
    "你看，这五个概念，其实都是你管人的那套事。大模型是选脑子，提示词是下指令，知识库是给培训，智能体是定岗位，工作流是沉淀经验。",
  ].join("\n\n");
  const candidate = [
    "第三块，知识库，相当于新员工的入职培训手册。新人报到后，你得把产品信息、客户沟通技巧、常见疑问都整理出来供他阅读，他才能迅速进入状态。AI也是这样，公司里各处散落的资料需要归拢起来，它才能派上用场。关键在于资料得事先整理好，否则AI再聪明也难为无米之炊。",
    "第四块，智能体，就像能独立承担任务的新员工。它并非什么都能干的万能助手，而是有明确职责范围和审核机制的数字员工。你需要为它制定岗位说明书，明确它能做什么、不能做什么，以及完成后由谁来检查。这如同给新员工划定职责，不能让他什么都做，也不能让他乱来。",
    "第五块，工作流，就是把优秀员工的做法固化成标准操作流程。你公司里肯定有业绩出色的老员工，他的经验能否沉淀下来，变成新人也能照着做的步骤？工作流正是为此而生。把一次成功的做法固定成可复用的流程，这比提示词更有价值。",
    "你看，这五个概念，其实都是你管理团队的那套逻辑。大模型负责选脑子，提示词负责下指令，知识库负责给培训，智能体负责定岗位，工作流负责沉淀经验。",
  ];
  const units = library.buildScriptUnits(source, library.SCRIPT_REWRITE_MAX_CHARACTERS);
  const validation = library.validateLightRewrite(units, candidate.map((text, index) => ({ paragraphId: units[index].paragraphId, text })));
  assert.equal(validation.checks.find((item) => item.key === "facts")?.passed, true);
  assert.equal(validation.checks.find((item) => item.key === "length")?.passed, false);
  assert.equal(library.isReviewableLightRewrite(validation), true);
});

test("restructure validates one-to-one facts and a genuinely changed narrative structure", () => {
  const units = library.buildScriptUnits("我们先解释企业为什么要记录数据。\n\n接着说明每天复盘的方法。\n\n最后给出2027年提升7.1%的目标。");
  const facts = [
    { factId: "f-001", kind: "reason", statement: "企业需要记录数据", sourceParagraphIds: ["p-0001"], immutableFacts: [] },
    { factId: "f-002", kind: "method", statement: "团队采用每天复盘的方法", sourceParagraphIds: ["p-0002"], immutableFacts: [] },
    { factId: "f-003", kind: "conclusion", statement: "目标是在2027年提升7.1%", sourceParagraphIds: ["p-0003"], immutableFacts: ["2027", "7.1%"] },
  ];
  const outline = [
    { sectionId: "s-01", title: "先给目标", role: "hook", factIds: ["f-003"], sourceParagraphIds: ["p-0003"] },
    { sectionId: "s-02", title: "再给方法", role: "mechanism", factIds: ["f-002", "f-001"], sourceParagraphIds: ["p-0002", "p-0001"] },
  ];
  assert.equal(library.validateRewriteFactCards(units, facts).passed, true);
  assert.equal(library.validateRestructurePlan(units, facts, outline).passed, true);
  const validation = library.validateRestructuredRewrite(
    units,
    facts,
    ["2027年先把提升7.1%的目标摆出来。", "达标要靠团队每天回看数据。", "持续记录，企业才能用真实结果校准行动。"],
    ["f-003", "f-002", "f-001"],
    outline,
  );
  assert.equal(validation.passed, true);
  assert.deepEqual(validation.missingImmutableFacts, []);
  assert.equal(validation.effectiveChangeCoveragePercent, Math.round((1 - validation.sequenceSimilarity) * 1000) / 10);
  const incompleteOutline = outline.map((section) => ({ ...section, factIds: section.factIds.filter((id) => id !== "f-001") }));
  const repairedOutline = library.repairRestructureOutline(facts, incompleteOutline);
  assert.equal(library.validateRestructurePlan(units, facts, repairedOutline).passed, true);
  assert.equal(repairedOutline.flatMap((section) => section.factIds).filter((id) => id === "f-001").length, 1);
});

test("micro homomorphic rewrite preserves source paragraph count and order instead of restructuring it", () => {
  const units = library.buildScriptUnits("先说清老板为什么要看责任心。\n\n再解释担当怎样推动能力成长。\n\n最后得出招聘不能降低责任心标准的结论。");
  const aligned = library.validateLightRewrite(units, [
    { paragraphId: "p-0001", text: "先讲明老板为何重视责任心。" },
    { paragraphId: "p-0002", text: "再说明担当如何带来能力成长。" },
    { paragraphId: "p-0003", text: "最后判断：招聘不能放低责任心标准。" },
  ]);
  assert.equal(aligned.passed, true);
  assert.equal(aligned.checks.find((item) => item.key === "mapping")?.passed, true);
  const reordered = library.validateLightRewrite(units, [
    { paragraphId: "p-0003", text: "先讲明老板为何重视责任心。" },
    { paragraphId: "p-0002", text: "再说明担当如何带来能力成长。" },
    { paragraphId: "p-0001", text: "最后判断：招聘不能放低责任心标准。" },
  ]);
  assert.equal(reordered.checks.find((item) => item.key === "mapping")?.passed, false);
});

test("restructure rejects copied paragraphs even when their order changes", () => {
  const units = library.buildScriptUnits("第一段解释为什么要先记录真实数据。\n\n第二段说明团队每天都要复盘。\n\n第三段给出2027年提升7.1%的目标。");
  const facts = [
    { factId: "f-001", kind: "reason", statement: "先记录真实数据", sourceParagraphIds: ["p-0001"], immutableFacts: [] },
    { factId: "f-002", kind: "method", statement: "团队每天复盘", sourceParagraphIds: ["p-0002"], immutableFacts: [] },
    { factId: "f-003", kind: "conclusion", statement: "2027年提升7.1%", sourceParagraphIds: ["p-0003"], immutableFacts: ["2027", "7.1%"] },
  ];
  const outline = [
    { sectionId: "s-01", title: "目标开场", role: "hook", factIds: ["f-003"], sourceParagraphIds: ["p-0003"] },
    { sectionId: "s-02", title: "方法解释", role: "mechanism", factIds: ["f-002", "f-001"], sourceParagraphIds: ["p-0002", "p-0001"] },
  ];
  const copied = library.validateRestructuredRewrite(
    units,
    facts,
    [units[2].text, units[1].text, units[0].text],
    ["f-003", "f-002", "f-001"],
    outline,
  );
  assert.equal(copied.passed, false);
  assert.equal(copied.checks.find((item) => item.key === "sequence_difference")?.passed, false);
});

test("semantic fact-card copying is a nonblocking warning while final prose remains protected", () => {
  const units = library.buildScriptUnits("一个真正把事情当成自己事情的人，遇到不会的地方会主动查资料并反复尝试。\n\n团队应在2027年实现7.1%的提升目标。");
  const copiedFacts = [
    { factId: "f-001", kind: "example", statement: "一个真正把事情当成自己事情的人，遇到不会的地方会主动查资料并反复尝试", sourceParagraphIds: ["p-0001"], immutableFacts: [] },
    { factId: "f-002", kind: "conclusion", statement: "2027年实现7.1%的提升", sourceParagraphIds: ["p-0002"], immutableFacts: ["2027", "7.1%"] },
  ];
  const validation = library.validateRewriteFactCards(units, copiedFacts);
  assert.equal(validation.passed, true);
  assert.deepEqual(validation.leakingFactIds, ["f-001"]);
  assert.equal(validation.warnings[0].passed, false);
  assert.equal(library.validateFactCardAbstraction(units, copiedFacts).passed, false);
});

test("a 24-character core conclusion may enter the fact ledger but cannot be copied into final prose", () => {
  const source = "问题不是该不该all in，而是在什么阶段all in。";
  const units = library.buildScriptUnits(source);
  const facts = [{ factId: "f-017", kind: "conclusion", statement: source, sourceParagraphIds: ["p-0001"], immutableFacts: [] }];
  const ledger = library.validateRewriteFactCards(units, facts);
  assert.equal(ledger.passed, true);
  assert.deepEqual(ledger.leakingFactIds, ["f-017"]);
  assert.equal(library.inspectLocalRewriteCopy(units, [source]).passed, false);
  assert.equal(library.inspectLocalRewriteCopy(units, ["真正要判断的并非是否押上全部，而是何时才具备这么做的条件。"]).passed, true);
});

test("copy detection does not join separate source sentences into a false copied span", () => {
  const source = "因为用户真正有需求的地方才是选题的起点。第二步就是继续拓展。";
  const units = library.buildScriptUnits(source);
  const candidate = "先把前面的道理讲明白：因为用户真正有需求的地方才是选题的起点，第二步再把它延展成一组不同角度。";
  const inspection = library.inspectLocalRewriteCopy(units, [candidate]);
  assert.equal(inspection.passed, true);
  assert.ok(inspection.longestCopiedSpan < 21);
});

test("a short residual copied phrase is reviewable while obvious copying remains blocked", () => {
  const source = "用户真正愿意付费的具体问题才是所有内容选题真正的起点。接下来要继续拆解不同人群的真实场景和具体痛点。";
  const units = library.buildScriptUnits(source);
  const candidate = "用户真正愿意付费的具体问题才是所有内容选题真正的起点。下一步要把不同人群遇到的场景与痛处继续拆开来讲。";
  const reviewable = library.validateLightRewrite(units, [{ paragraphId: "p-0001", text: candidate }]);
  const copied = library.validateLightRewrite(units, [{ paragraphId: "p-0001", text: source }]);
  assert.equal(reviewable.checks.find((item) => item.key === "local_copy")?.passed, false);
  assert.equal(library.isReviewableLightRewrite(reviewable), true);
  assert.equal(library.isReviewableLightRewrite(copied), false);
});

test("fact-ledger completeness, unique IDs and immutable facts remain hard gates", () => {
  const units = library.buildScriptUnits("第一段记录2027年目标。\n\n第二段要求增长7.1%。");
  const invalid = [
    { factId: "f-001", kind: "fact", statement: "记录目标", sourceParagraphIds: ["p-0001"], immutableFacts: [] },
    { factId: "f-001", kind: "claim", statement: "重复编号", sourceParagraphIds: ["p-0001"], immutableFacts: [] },
  ];
  const validation = library.validateRewriteFactCards(units, invalid);
  assert.equal(validation.passed, false);
  assert.equal(validation.checks.find((item) => item.key === "fact_cards")?.passed, false);
  assert.equal(validation.checks.find((item) => item.key === "source_coverage")?.passed, false);
  assert.equal(validation.checks.find((item) => item.key === "fact_immutables")?.passed, false);
});

test("a long source cannot be collapsed into a conclusion-only fact ledger", () => {
  const units = library.buildScriptUnits("完整案例需要保留背景、原因、过程、转折、结果和适用限制。".repeat(80), library.SCRIPT_REWRITE_MAX_CHARACTERS);
  const validation = library.validateRewriteFactCards(units, [{
    factId: "f-001",
    kind: "conclusion",
    statement: "结论是应当保留完整案例。",
    sourceParagraphIds: ["p-0001"],
    immutableFacts: [],
  }]);
  assert.equal(validation.passed, false);
  assert.equal(validation.checks.find((item) => item.key === "fact_detail_coverage")?.passed, false);
});

test("a dense long-form fact ledger above the hard floor can proceed below the preferred detail target", () => {
  const source = "完整案例背景原因过程结果限制".repeat(100);
  const statement = "案例背景原因过程结果限制".repeat(48);
  const units = library.buildScriptUnits(source, library.SCRIPT_REWRITE_MAX_CHARACTERS);
  const validation = library.validateRewriteFactCards(units, [{
    factId: "f-001",
    kind: "example",
    statement,
    sourceParagraphIds: ["p-0001"],
    immutableFacts: [],
  }]);
  assert.equal(validation.passed, true);
  assert.equal(validation.checks.find((item) => item.key === "fact_detail_coverage")?.passed, true);
  assert.equal(validation.warnings.find((item) => item.key === "fact_detail_target")?.passed, false);
});

test("semantic fact cards allow short faithful phrases needed to preserve meaning", () => {
  const units = library.buildScriptUnits("今天先列出业务里最耗人力的三个重复环节，再判断规则是否清晰。\n\n企业AI先讲落地再讲工具，工具是拿来用的。");
  const facts = [
    { factId: "f-001", kind: "action", statement: "列出最耗人力的三个重复环节，并检查规则清晰度。", sourceParagraphIds: ["p-0001"], immutableFacts: [] },
    { factId: "f-002", kind: "conclusion", statement: "企业AI应先考虑落地，再选择工具。", sourceParagraphIds: ["p-0002"], immutableFacts: [] },
  ];
  const validation = library.validateRewriteFactCards(units, facts);
  assert.equal(validation.passed, true);
  assert.deepEqual(validation.leakingFactIds, []);
});

test("restructure rejects one copied paragraph even when the whole draft changes enough", () => {
  const units = library.buildScriptUnits("真正负责的人会主动确认结果是否正确，并复盘哪里还可以继续改进。\n\n团队遇到难题时，愿意向前站的人会在实战中持续增长能力。\n\n管理者最后应该优先选择愿意承担结果的人。");
  const facts = [
    { factId: "f-001", kind: "reason", statement: "责任感推动结果复核", sourceParagraphIds: ["p-0001"], immutableFacts: [] },
    { factId: "f-002", kind: "example", statement: "承担难题促进实战成长", sourceParagraphIds: ["p-0002"], immutableFacts: [] },
    { factId: "f-003", kind: "conclusion", statement: "选人优先考察担当", sourceParagraphIds: ["p-0003"], immutableFacts: [] },
  ];
  const outline = [
    { sectionId: "s-01", title: "结论前置", role: "hook", factIds: ["f-003"], sourceParagraphIds: ["p-0003"] },
    { sectionId: "s-02", title: "解释成长", role: "mechanism", factIds: ["f-002", "f-001"], sourceParagraphIds: ["p-0002", "p-0001"] },
  ];
  const validation = library.validateRestructuredRewrite(
    units,
    facts,
    ["选人的关键，不只是看眼下会什么，更要看他是否愿意为最终结果负责。", "真正负责的人会主动确认结果是否正确，并复盘哪里还可以继续改进。", "当困难出现时，肯接住问题的人会通过一次次实践拓宽能力边界。"],
    ["f-003", "f-002", "f-001"],
    outline,
  );
  assert.equal(validation.passed, false);
  assert.equal(validation.checks.find((item) => item.key === "local_copy")?.passed, false);
  assert.deepEqual(validation.copiedParagraphIndexes, [1]);
});

test("targeted paragraph repair preserves every untouched paragraph byte-for-byte", () => {
  const units = library.buildScriptUnits("第一段原稿。\n\n第二段原稿。\n\n第三段原稿。");
  const originalRows = [
    { paragraphId: "p-0001", text: "第一段已经改写。" },
    { paragraphId: "p-0002", text: "第二段已经改写。" },
    { paragraphId: "p-0003", text: "第三段已经改写。" },
  ];
  const merged = library.mergeRewriteParagraphRows(units, originalRows, [{ paragraphId: "p-0002", text: "只替换第二段。" }]);
  assert.deepEqual(merged, [originalRows[0], { paragraphId: "p-0002", text: "只替换第二段。" }, originalRows[2]]);
});

test("copy diagnostics expose the actual forbidden span and candidate scoring rejects repair regressions", () => {
  const source = "越是资源少的人越需要谨慎试错，但越是资源少的人越没有试错空间，于是被逼着必须一次做对。";
  const units = library.buildScriptUnits(source);
  const first = library.validateLightRewrite(units, [{ paragraphId: "p-0001", text: "资源越有限，越应该把尝试拆小；可现实偏偏不给人反复试验的余地，最后只能押在一次结果上。" }]);
  const regressed = library.validateLightRewrite(units, [{ paragraphId: "p-0001", text: `${source}啊` }]);
  assert.ok(regressed.copiedSpans.some((item) => item.includes("越是资源少的人越需要谨慎试错")));
  assert.ok(library.rewriteValidationQualityScore(first) > library.rewriteValidationQualityScore(regressed));
});

test("equivalent reconstruction allocates an explicit whole-document and per-section character budget", () => {
  const source = "这是一篇需要保留完整推理过程的长文案。".repeat(100);
  const facts = [
    { factId: "f-001", kind: "reason", statement: "保留完整的推理原因、过程与限制条件", sourceParagraphIds: ["p-0001"], immutableFacts: [] },
    { factId: "f-002", kind: "conclusion", statement: "重新组织结构但不能压缩为摘要", sourceParagraphIds: ["p-0001"], immutableFacts: [] },
  ];
  const outline = [
    { sectionId: "s-01", title: "原因", role: "mechanism", factIds: ["f-001"], sourceParagraphIds: ["p-0001"] },
    { sectionId: "s-02", title: "结论", role: "conclusion", factIds: ["f-002"], sourceParagraphIds: ["p-0001"] },
  ];
  const targets = library.buildRestructureLengthTargets(source, facts, outline);
  assert.equal(targets.targetCharacters, Math.round(targets.sourceCharacters * 0.95));
  assert.equal(targets.minimumCharacters, Math.ceil(targets.sourceCharacters * 0.5));
  assert.equal(targets.maximumCharacters, Math.floor(targets.sourceCharacters * 1.25));
  assert.equal(targets.sections.reduce((sum, item) => sum + item.targetCharacters, 0), targets.targetCharacters);
  assert.ok(targets.sections.every((item) => item.minimumCharacters < item.targetCharacters && item.maximumCharacters > item.targetCharacters));
});

test("a concise reconstruction passes when it independently covers every proposition", () => {
  const source = "许多管理者开始推进业务改造时，习惯先盯着工具清单，反复比较功能、价格和演示效果，却没有先说清楚团队真正卡在哪里。工具买回来以后，员工不知道该在什么环节使用，管理层也无法判断投入到底有没有带来改善，最后项目看起来很热闹，业务流程却没有变化。\n\n真正需要先做的是把业务流程重新走一遍，找出反复发生、持续消耗人力并且规则相对清晰的工作。只有把具体场景、输入信息、判断标准和期望结果说明白，团队才知道技术应该接在哪个位置，也才能判断这个环节是否值得改造。\n\n因此，推进业务改造的顺序应该从问题和流程开始，再决定采用什么工具。管理者要先明确真实瓶颈，让团队围绕同一个结果协作，之后再用实际数据复盘效果。这样工具才会成为解决问题的手段，而不是摆在会议里的展示品。";
  const units = library.buildScriptUnits(source);
  const facts = [
    { factId: "f-a", kind: "problem", statement: "只比较工具会导致使用场景和投入结果不清楚", sourceParagraphIds: ["p-0001"], immutableFacts: [] },
    { factId: "f-b", kind: "method", statement: "先梳理流程并明确场景输入判断标准和结果", sourceParagraphIds: ["p-0002"], immutableFacts: [] },
    { factId: "f-c", kind: "conclusion", statement: "先找业务瓶颈再选工具并用数据复盘", sourceParagraphIds: ["p-0003"], immutableFacts: [] },
  ];
  const outline = [
    { sectionId: "s-a", title: "问题前置", role: "hook", factIds: ["f-c"], sourceParagraphIds: ["p-0003"] },
    { sectionId: "s-b", title: "错误路径", role: "problem", factIds: ["f-a"], sourceParagraphIds: ["p-0001"] },
    { sectionId: "s-c", title: "实施方法", role: "method", factIds: ["f-b"], sourceParagraphIds: ["p-0002"] },
  ];
  const paragraphs = [
    "别急着选工具，先问业务到底被什么拖住。管理层若只比较功能和演示，员工拿到系统后仍不知道该用在哪，投入自然无法兑现成结果。",
    "把现有流程完整过一遍，锁定持续耗人、重复出现且判断规则明确的环节；再写清输入、判断方式和预期输出，技术的接入点才会浮现。",
    "所以顺序应当反过来：先确认瓶颈，让团队围绕同一个目标协作，再挑合适的工具，最后用真实数据复盘。工具只是解决问题的手段，不该成为会议上的展品。",
  ];
  const validation = library.validateRestructuredRewrite(units, facts, paragraphs, ["f-c", "f-a", "f-b"], outline);
  assert.ok(validation.lengthRatio > 0.5 && validation.lengthRatio < 0.8);
  assert.equal(validation.passed, true);
});

test("same-order outline grouping is not accepted as a rebuilt narrative and long outlines are compacted", () => {
  const units = library.buildScriptUnits("第一项。\n\n第二项。\n\n第三项。\n\n第四项。");
  const facts = units.map((unit, index) => ({ factId: `f-00${index + 1}`, kind: "claim", statement: unit.text, sourceParagraphIds: [unit.paragraphId], immutableFacts: [] }));
  const sameOrder = facts.map((fact, index) => ({ sectionId: `s-0${index + 1}`, title: `第${index + 1}节`, role: "claim", factIds: [fact.factId], sourceParagraphIds: fact.sourceParagraphIds }));
  assert.equal(library.validateRestructurePlan(units, facts, sameOrder).passed, false);
  const longOutline = Array.from({ length: 18 }, (_, index) => ({
    sectionId: `s-${String(index + 1).padStart(2, "0")}`,
    title: `章节${index + 1}`,
    role: "mechanism",
    factIds: [facts[index % facts.length].factId + `-${index}`],
    sourceParagraphIds: [],
  }));
  const longFacts = longOutline.map((section, index) => ({ factId: section.factIds[0], kind: "claim", statement: `命题${index + 1}`, sourceParagraphIds: [units[index % units.length].paragraphId], immutableFacts: [] }));
  const compacted = library.compactRestructureOutline(longFacts, longOutline, 8);
  assert.ok(compacted.length <= 8);
  assert.deepEqual(compacted.flatMap((item) => item.factIds), longOutline.flatMap((item) => item.factIds));
});

test("a deterministic fallback outline keeps every fact when the planner is unavailable", () => {
  const units = library.buildScriptUnits("先识别问题。\n\n再解释原因。\n\n然后给出方法。\n\n最后形成结论。");
  const facts = units.map((unit, index) => ({
    factId: `f-00${index + 1}`,
    kind: index === units.length - 1 ? "conclusion" : "claim",
    statement: unit.text,
    sourceParagraphIds: [unit.paragraphId],
    immutableFacts: [],
  }));
  const outline = library.fallbackRestructureOutline(facts);
  assert.equal(library.validateRestructurePlan(units, facts, outline).passed, true);
  assert.deepEqual(new Set(outline.flatMap((item) => item.factIds)), new Set(facts.map((item) => item.factId)));
  assert.notEqual(outline.flatMap((item) => item.factIds)[0], facts[0].factId);
});

test("long micro paragraphs are individually length-gated and Chinese year forms cannot become Arabic digits", () => {
  const sourceParagraph = `一九八七年开始，${"创业者需要保留完整案例、判断依据和行动过程。".repeat(20)}`;
  const units = library.buildScriptUnits(sourceParagraph, library.SCRIPT_REWRITE_MAX_CHARACTERS);
  const compressed = `1987年开始，${"创业者需要保留案例和判断。".repeat(10)}`;
  const validation = library.validateLightRewrite(units, [{ paragraphId: "p-0001", text: compressed }]);
  assert.equal(validation.passed, false);
  assert.equal(validation.checks.find((item) => item.key === "paragraph_lengths")?.passed, false);
  assert.equal(validation.checks.find((item) => item.key === "no_new_facts")?.passed, false);
  const targets = library.rewriteParagraphTargets(units);
  assert.equal(targets[0].minimumCharacters, Math.ceil(targets[0].sourceCharacters * 0.9));
  assert.equal(targets[0].maximumCharacters, Math.floor(targets[0].sourceCharacters * 1.1));
});

test("rewrite workspace is project-scoped, versioned and uses the confirmed rewrite specifications", async () => {
  const [listApi, detailApi, generateApi, prompts, component, page, shell, schema, migration, adapter] = await Promise.all([
    readFile(new URL("../app/api/script-rewrites/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/script-rewrites/[rewriteId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/script-rewrites/[rewriteId]/generate/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/script-rewrite-prompts.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/ScriptRewriteWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/script-rewrite/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0029_script_rewrite_workspace.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/model-adapter.ts", import.meta.url), "utf8"),
  ]);
  assert.match(listApi, /getProjectAccess/);
  assert.match(listApi, /v\.organization_id = \? AND v\.project_id = \?/);
  assert.match(listApi, /人工校正版/);
  assert.match(listApi, /AI 校正原版/);
  assert.match(listApi, /ASR 原稿/);
  assert.match(listApi, /sourceTranscriptVersion/);
  assert.doesNotMatch(listApi, /reanalyze|analysis_jobs.*INSERT/is);
  assert.match(detailApi, /script_rewrite_versions/);
  assert.match(detailApi, /manual_version_saved/);
  assert.match(generateApi, /invokeContentModel/);
  assert.match(generateApi, /nativeJson: attempt === 0/);
  assert.match(generateApi, /MODEL_OUTPUT_TRUNCATED/);
  assert.match(generateApi, /INVALID_MODEL_OUTPUT/);
  assert.match(generateApi, /readContentModelConfig/);
  assert.doesNotMatch(generateApi, /PROJECT_ASSISTANT|ANALYZER_VISION/);
  assert.match(generateApi, /script_rewrite_micro_homomorphic_body/);
  assert.match(generateApi, /script_rewrite_micro_homomorphic_audit/);
  assert.match(generateApi, /script_rewrite_micro_homomorphic_repair/);
  assert.match(generateApi, /script_rewrite_micro_homomorphic_batch_repair_retry/);
  assert.match(generateApi, /script_rewrite_restructure_section_repair/);
  assert.match(generateApi, /script_rewrite_restructure_section_repair_retry/);
  assert.match(generateApi, /compactRestructureOutline/);
  assert.match(generateApi, /factLedgerQualityScore/);
  assert.match(generateApi, /rewriteValidationQualityScore/);
  assert.match(generateApi, /isReviewableDraft/);
  assert.match(generateApi, /isReviewableLightRewrite/);
  assert.match(generateApi, /fallbackRestructureOutline/);
  assert.match(generateApi, /completeGeneratedSections/);
  assert.match(generateApi, /withUnavailableSemanticAudit/);
  assert.match(generateApi, /problemParagraphIds\.length === 0/);
  assert.match(generateApi, /const required = \["content", "coverage", "plan_execution", "structure"\]/);
  assert.doesNotMatch(generateApi, /script_rewrite_light_restructure_plan/);
  assert.match(generateApi, /script_rewrite_restructure_facts/);
  assert.match(generateApi, /script_rewrite_restructure_plan_repair/);
  assert.match(generateApi, /script_rewrite_restructure_audit/);
  assert.match(generateApi, /script_rewrite_restructure_semantic_repair/);
  assert.match(generateApi, /script_rewrite_restructure_audit_retry/);
  assert.match(generateApi, /EQUIVALENT_WRITER_PROMPT/);
  assert.match(prompts, /段落数量和内容顺序完全一致/);
  assert.match(prompts, /90%—110%/);
  assert.match(prompts, /problem_paragraph_ids/);
  assert.match(prompts, /中文数字不能改成阿拉伯数字/);
  assert.match(prompts, /不能只留下释义/);
  assert.match(prompts, /length_target\.minimum_characters/);
  assert.match(prompts, /不能形成明显的逐段对应关系/);
  assert.match(prompts, /禁止虚构人物、经历、案例、数据/);
  assert.match(generateApi, /single|单版重试|retryOfRunId/);
  assert.match(component, /未选择 = 0 次调用/);
  assert.doesNotMatch(component, /window\.confirm/);
  assert.match(component, /rewrite-confirm-dialog/);
  assert.match(component, /原文 \/ 结果并排核对/);
  assert.match(component, /保存为新版本/);
  assert.match(component, /建议人工复核/);
  assert.doesNotMatch(component, /校验未通过/);
  assert.match(component, /单独重试这一版/);
  assert.match(component, /微调同构/);
  assert.match(component, /maximumCallCount/);
  assert.doesNotMatch(component, /重新安排开场、段落顺序/);
  assert.match(component, /selectedVersion\.variant === "light_rewrite"/);
  assert.match(page, /微调同构或内容等价重构/);
  assert.match(shell, /口播改写/);
  assert.match(schema, /scriptRewriteWorkspaces/);
  assert.match(schema, /scriptRewriteRuns/);
  assert.match(schema, /scriptRewriteVersions/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS script_rewrite_workspaces/);
  assert.match(adapter, /maxTokens\?: number/);
  assert.match(adapter, /temperature\?: number/);
});
