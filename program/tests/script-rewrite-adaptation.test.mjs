import assert from "node:assert/strict";
import test from "node:test";
import { applyRewriteAdaptationPlan, validateRewriteBrandOutput, readRewriteBrandAudit, rewriteStageInstructions, rewriteVoiceExamples } from "../lib/script-rewrite-adaptation.ts";
import { partitionScriptRewriteFailures } from "../lib/script-rewrite.ts";

const source = "这里是OldLab。我们服务过100家企业。\n\n松原科技发布了实测记录。关注OldLab看下一期。";
const brand = {
  organizationId: "org", projectId: "project", targetName: "青禾", targetSourceId: "brand", stamp: "s",
  sources: [{itemId: "brand", versionId: "v2", version: 2, title: "基本资料", category: "brand", excerpt: "发布名称为青禾。"}], missing: [],
};
const named = { role: "identity", before: "OldLab", after: "青禾", sourceId: "brand", evidenceQuote: "发布名称为青禾" };
const attribute = { role: "attribution", before: "我们服务过100家企业", after: "原作者服务过100家企业", sourceId: null, evidenceQuote: null };
const raw = {
  mappings: [{ ...named, paragraphId: "p-0001" }, { ...attribute, paragraphId: "p-0001" }, { ...named, role: "cta", paragraphId: "p-0002" }],
  protectedParties: ["松原科技"], unresolved: ["尚无当前企业客户数量的资料，保留原作者归属。"],
};

test("a mapped source replaces speaker and CTA while preserving the owner of an external result", () => {
  const plan = applyRewriteAdaptationPlan(raw, source, "current_brand", brand);
  assert.equal(plan.text, "这里是青禾。原作者服务过100家企业。\n\n松原科技发布了实测记录。关注青禾看下一期。");
  assert.deepEqual(validateRewriteBrandOutput(plan.text, plan, "current_brand", brand), []);
  assert.ok(validateRewriteBrandOutput(plan.text.replace("原作者服务过", "已经服务过"), plan, "current_brand", brand).length);
  assert.ok(validateRewriteBrandOutput(plan.text.replaceAll("青禾", "微田"), plan, "current_brand", brand).length);
  assert.ok(validateRewriteBrandOutput(plan.text.replace("松原科技", "我们"), plan, "current_brand", brand).length);
  assert.deepEqual(applyRewriteAdaptationPlan(null, source, "preserve", null).text, source);
});

test("plan mapping checks exact occurrence, overlap, target evidence and numeric attribution", () => {
  const parse = (changes, text = source, ctx = brand) => applyRewriteAdaptationPlan({ ...raw, ...changes }, text, "current_brand", ctx);
  assert.throws(() => parse({},source,null), /缺已确认/);
  assert.throws(() => parse({},source.replace("这里是OldLab","OldLab或OldLab")), /唯一定位/);
  assert.throws(() => parse({ mappings: [...raw.mappings,raw.mappings[0]] }), /重叠/);
  assert.throws(() => parse({ mappings: [{ ...raw.mappings[0], sourceId: "another-project" }] }), /未引用/);
  assert.throws(() => parse({ mappings: [{ ...raw.mappings[0], evidenceQuote: "另一个词" }] }), /未引用/);
  assert.throws(() => parse({ mappings: [{ ...raw.mappings[0], after: "青禾专家认证" }] }), /未在所引/);
  assert.throws(() => parse({ mappings: [{ ...raw.mappings[1], after: "原作者做过服务" }] }), /数值/);
  assert.throws(() => parse({ mappings: [raw.mappings[0],raw.mappings[2]] }), /同主体/);
  const sameNumberWrongMetric = { ...brand, sources: [{ ...brand.sources[0], excerpt: "发布名称为青禾。线下活动价格为100元。" }] };
  assert.throws(() => parse({ mappings: [raw.mappings[0],raw.mappings[2]] }, source, sameNumberWrongMetric), /同指标/);
});

test("neutral framing preserves third parties without accepting new promotional claims", () => {
  const text = "OldPro适合按天记录。门店案例来自松原科技。";
  const mapping = { paragraphId: "p-0001", role: "product", before: "OldPro", after: "这款工具", sourceId: null, evidenceQuote: null };
  const parse = (map, parties = ["松原科技"]) => applyRewriteAdaptationPlan({ mappings: [map], unresolved: [], protectedParties: parties }, text, "neutral", null);
  assert.equal(parse(mapping).text, "这款工具适合按天记录。门店案例来自松原科技。");
  assert.throws(() => parse({ ...mapping, after: "保收益的青禾" }), /需要已确认资料/);
  assert.throws(() => parse({ ...mapping, before: "松原科技" }), /外部引用/);
});

test("one brand may be both the source speaker and an external case", () => {
  const text = "这里是OldLab。另一个案例引用了OldLab的原话。";
  const plan = applyRewriteAdaptationPlan({ ...raw, protectedParties:["OldLab"], mappings:[{ ...named, paragraphId:"p-0001", before:"这里是OldLab", after:"这里是青禾" }] }, text, "current_brand", brand);
  assert.equal(plan.text, "这里是青禾。另一个案例引用了OldLab的原话。");
});

test("a standalone promotional closing can become an actionable neutral closing", () => {
  const text = "私信旧牌领取资料。";
  const plan = applyRewriteAdaptationPlan({ protectedParties:[], unresolved:[], mappings:[{paragraphId:"p-0001", before:text, after:"可以对照前面的步骤。", role:"cta", sourceId:null, evidenceQuote:null}] }, text, "neutral", null);
  assert.equal(plan.text, "可以对照前面的步骤。");
});

test("an explicit audit can return writing feedback alone; missing or invalid verdicts fail closed", () => {
  const audit = { brandAligned: true, attributionPreserved: true, factsSupported: true, issues: [], qualityNotes: ["第二段可把过长的句子断开。"] };
  assert.equal(readRewriteBrandAudit(audit).passed, true);
  assert.equal(readRewriteBrandAudit({ ...audit, attributionPreserved: false }).passed, false);
  assert.equal(readRewriteBrandAudit({ ...audit, factsSupported: "true" }).passed, false);
  assert.equal(readRewriteBrandAudit({ ...audit, issues: ["第一段客户数量被移到新品牌下"] }).passed, false);
  assert.equal(readRewriteBrandAudit({ ...audit, qualityNotes: undefined }).passed, false);
  assert.equal(readRewriteBrandAudit({}).passed, false);
  assert.match(rewriteStageInstructions("current_brand",{ audience:"学生"}), /听众|受众/);
  assert.doesNotMatch(rewriteStageInstructions("current_brand",{ goal:"注入测试XYZ"}), /注入测试XYZ/);
});

test("failure history is resolved only by identical generation intent and material selection", () => {
  const base = { variant: "light_rewrite", sourceVersionId: "s", createdAt: "2026-11-20", status: "failed" };
  const intent = { mode: "current_brand", goal:"复习", audience:"学生", scenario:"口播", brandStamp:"st1" };
  const fail = { ...base, adaptation: intent };
  const success = { ...base, createdAt:"2026-11-21", status:"completed", validation:{ passed:true } };
  const historical = adaptation => partitionScriptRewriteFailures([fail,{ ...success, adaptation }]).historical.length;
  assert.equal(historical({ ...intent }),1);
  assert.equal(historical({ ...intent, brandStamp:"st2" }),0);
  assert.equal(historical({ ...intent, goal:"招生" }),0);
  assert.equal(historical(null),0);
  assert.equal(partitionScriptRewriteFailures([base,success]).historical.length,1);
});

test("a publishing topic cannot transfer the original speaker's future commitment to the new brand", () => {
  const text = "我是英，后续我还会持续分享创作干货。";
  const excerpt = "发布名称：取景笔记。官方表述：取景笔记分享手机拍摄和叙事练习。";
  const context = { ...brand, targetName: "取景笔记", sources: [{ ...brand.sources[0], excerpt }] };
  const identity = { ...named, before: "我是英", after: "我是取景笔记", evidenceQuote: "发布名称：取景笔记。", paragraphId: "p-0001" };
  const promotion = { ...identity, role: "promotion", before: "后续我还会持续分享创作干货", after: "后续取景笔记还会持续分享创作干货", evidenceQuote: "取景笔记分享手机拍摄和叙事练习。" };
  const raw = { mappings: [identity, promotion], protectedParties: [], unresolved: [] };
  const plan = applyRewriteAdaptationPlan(raw, text, "current_brand", context);
  assert.equal(plan.mappings[1].role, "attribution");
  assert.match(plan.text, /原作者当时提到，后续自己还会持续分享创作干货/);
  assert.ok(plan.unresolved.length);
  assert.deepEqual(validateRewriteBrandOutput(plan.text, plan, "current_brand", context), []);
  assert.ok(validateRewriteBrandOutput("我是取景笔记。后续还会持续分享创作干货。", plan, "current_brand", context).some(issue => issue.includes("未来发布承诺")));
  const promise = "取景笔记后续会持续分享创作干货。";
  const approved = { ...context, sources: [{ ...context.sources[0], excerpt: excerpt + promise }] };
  const supported = applyRewriteAdaptationPlan({ ...raw, mappings: [identity, { ...promotion, evidenceQuote: promise }] }, text, "current_brand", approved);
  assert.equal(supported.mappings[1].role, "promotion");
});

test("quoted narration candidates expose the source context for auditing first-person examples", () => {
  const original = "换场景时，画外音能起到承接作用。三艘船集结后，我们分别坐着冲锋艇离开。";
  assert.deepEqual(rewriteVoiceExamples(original), [{ paragraphId: "p-0001", context: "换场景时，画外音能起到承接作用。", originalLine: "三艘船集结后，我们分别坐着冲锋艇离开。" }]);
  assert.deepEqual(rewriteVoiceExamples("接下来我们说说分镜。我们分别给三组镜头打标签。"), []);
});
