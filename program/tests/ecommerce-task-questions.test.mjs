import assert from "node:assert/strict";
import test from "node:test";
import { productPublicSchema, taskBriefSchema } from "../lib/ecommerce/contracts.ts";
import { firstVideoTaskTitle, initialTaskDraft, taskBriefForProduct, taskQuestionOptions, taskQuestionSelection } from "../lib/ecommerce/task-question-options.ts";

const product = productPublicSchema.parse({
  audience: { user: "康复训练者", buyer: "本人或护理家属", source: "已确认的访谈记录", status: "confirmed" },
  claims: [], scenarios: "手部活动受限时整理日常用品", purchaseConcerns: "是否适合左手使用", landingUrl: "https://example.invalid/product/sku-01",
});
const products = [{ name: "测试用品", version_id: "current-scope-version", public_json: JSON.stringify(product) }];

test("first-video defaults use only a selected product version available in this space", () => {
  const draft = initialTaskDraft({ products, initialProductVersionId: "current-scope-version", guided: true });
  assert.equal(draft.title, "测试用品 · 第一条商品视频");
  assert.equal(draft.versionId, products[0].version_id);
  assert.equal(draft.brief.audience.user, "康复训练者");
  assert.equal(draft.brief.audience.buyer, "本人或护理家属");
  assert.equal(draft.brief.scene, product.scenarios);
  assert.equal(draft.brief.barrier, product.purchaseConcerns);
  assert.equal(draft.brief.destination, product.landingUrl);
  assert.deepEqual([draft.brief.platform, draft.brief.traffic, draft.brief.target, draft.brief.durationSec], ["douyin", "organic", "product_click", 30]);
  assert.equal(draft.brief.claimId, "");
  assert.deepEqual(draft.brief.evidenceIds, []);
  const foreign = initialTaskDraft({ products, initialProductVersionId: "another-space-version", guided: true });
  assert.equal(foreign.versionId, "");
  assert.equal(foreign.brief.audience.user, "");
});

test("guide defaults never replace a saved task's custom answers or advanced selections", () => {
  const brief = taskBriefSchema.parse({ audience: { user: "轮班护士", buyer: "自费使用者", source: "客户原话", status: "confirmed" }, scene: "深夜交接班", barrier: "缺少特定型号兼容性资料", platform: "wechat_channels", traffic: "paid", target: "live_entry", durationSec: 82, destination: "企业直播间中的指定栏目", filming: ["hands", "screen"], filmingNotes: "不用真人露脸", knowledgeIds: ["knowledge-1"], caseIds: ["case-1"], componentIds: ["method-1"], excludedConditions: ["不能使用竞品标识"], strategyException: "本轮服务老客户", instructions: "保留技术参数名称" });
  const row = { title: "已有任务", product_version_id: "saved-version", brief_json: JSON.stringify(brief) };
  const draft = initialTaskDraft({ row, products, initialProductVersionId: "current-scope-version", guided: true });
  assert.equal(draft.title, row.title);
  assert.equal(draft.versionId, row.product_version_id);
  assert.deepEqual(draft.brief, brief);
});

test("changing the selected product preserves video settings and all optional context", () => {
  const brief = taskBriefSchema.parse({ audience: {}, claimId: "previous-claim", evidenceIds: ["previous-evidence"], platform: "other", traffic: "paid", target: "purchase", durationSec: 78, knowledgeIds: ["knowledge-1"], caseIds: ["case-1"], componentIds: ["method-1"], instructions: "只补充这次要求", strategyException: "已填写的例外" });
  const next = taskBriefForProduct(brief, product);
  assert.equal(next.claimId, "");
  assert.deepEqual(next.evidenceIds, []);
  for (const key of ["platform", "traffic", "target", "durationSec", "knowledgeIds", "caseIds", "componentIds", "instructions", "strategyException"]) assert.deepEqual(next[key], brief[key]);
  next.audience.user = "改为另一个使用者";
  assert.equal(product.audience.user, "康复训练者");
});

test("custom answers are not shortened or guessed into suggested answer labels", () => {
  assert.equal(taskQuestionSelection("家庭用户", taskQuestionOptions.user), "家庭用户");
  for (const value of ["家庭用户中的左利手成员", "  家庭用户", "企业护理人员", "自行填写"]) assert.equal(taskQuestionSelection(value, taskQuestionOptions.user), "custom");
  assert.equal(taskQuestionSelection("", taskQuestionOptions.user), "");
});

test("a long product name still creates a valid bounded task title without splitting characters", () => {
  const title = firstVideoTaskTitle("😀".repeat(200));
  assert.ok(title.length <= 300);
  assert.ok(title.endsWith(" · 第一条商品视频"));
  assert.doesNotMatch(title, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
});
