import assert from "node:assert/strict";
import test from "node:test";
import { assessEcommerceCopyReadiness } from "../lib/ecommerce/copy-readiness.ts";
import { productPublicSchema } from "../lib/ecommerce/contracts.ts";
import { ecommerceFixture } from "./helpers/ecommerce-fixture.mjs";

test("old product JSON receives empty writing-material fields without inventing content", () => {
  const product = productPublicSchema.parse({ audience: {}, claims: [] });
  assert.deepEqual(product.copyFacts, { content: "", usage: "", difference: "", delivery: "", limitations: "", speakerExperience: "" });
  assert.equal(product.sellingPoints, "");
  assert.equal(productPublicSchema.safeParse({ ...product, copyFacts: { unknownExperience: "cannot enter" } }).success, false);
  assert.equal(productPublicSchema.safeParse({ ...product, copyFacts: { content: "字".repeat(2501) } }).success, false);
});

test("a bare AI-course name, numeric quantity and cheapness are not enough to write an advert", () => {
  const product = { name: "AI课程", category: "课程与知识服务", specification: "1", sellingPoints: "便宜", scenarios: "课程学习与练习" };
  const result = assessEcommerceCopyReadiness({ product });
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing.map(gap => gap.field), ["content", "usage"]);
  assert.match(result.missing[0].label, /教什么/);
  assert.ok(result.missing.every(gap => gap.reason && gap.example));
});

test("actual course content and a learning task support writing without a claimed outcome or testimonial", () => {
  const product = {
    name: "办公AI入门", category: "课程与知识服务", specification: "8节录播", scenarios: "办公或学习",
    copyFacts: { content: "课程包含需求拆解、提示词修改和PPT初稿练习。", usage: "学习者把一份真实工作需求拆成输入信息和输出格式，再按示范修改提示词。", difference: "", delivery: "每节配练习题和可编辑示例文件。", limitations: "需要自行完成练习，不提供代做。", speakerExperience: "" },
  };
  assert.equal(assessEcommerceCopyReadiness({ product }).ready, true);
});

test("a physical product can use existing concrete specifications and operation details", () => {
  const product = { name: "随行杯", category: "家居日用", specification: "容量500ml", sellingPoints: "采用旋盖结构，可以旋开与旋紧。", scenarios: "办公或学习" };
  assert.equal(assessEcommerceCopyReadiness({ product }).ready, true);
});

test("legacy detailed selling points need not be copied into the new structured fields", () => {
  const product = { name: "办公课程", category: "课程与知识服务", specification: "", sellingPoints: "每节课配有一个PPT或表格练习任务，包含可编辑的示例文件。", scenarios: "课程学习与练习" };
  assert.equal(assessEcommerceCopyReadiness({ product }).ready, true);
});

test("several empty adjectives and a limitation alone do not replace actual product content", () => {
  const product = { name: "AI课程", category: "课程与知识服务", specification: "1门", sellingPoints: "便宜。好用。高性价比。", scenarios: "课程学习与练习", copyFacts: { limitations: "需要学习者自己完成练习，不提供代做。" } };
  const result = assessEcommerceCopyReadiness({ product });
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing.map(gap => gap.field), ["content"]);
});

test("readiness uses actual task context and never fills or changes product facts", () => {
  const product = { name: "随行杯", category: "家居日用", specification: "容量500ml", sellingPoints: "", scenarios: "日常使用" };
  const snapshot = JSON.stringify(product);
  assert.equal(assessEcommerceCopyReadiness({ product }).ready, false);
  assert.equal(assessEcommerceCopyReadiness({ product, brief: { scene: "办公桌日常喝水" } }).ready, true);
  assert.equal(JSON.stringify(product), snapshot);
});

test("writing materials save as public product facts while sparse products can still be saved", async t => {
  const f = await ecommerceFixture(t); await f.enable();
  const sparse = await f.saveProduct({ status: "confirmed", publicData: { ...f.productInput.publicData, category: "课程与知识服务", specification: "1", sellingPoints: "便宜" } });
  assert.ok(sparse.versionId);
  const copyFacts = { content: "实际课程包含PPT需求拆解练习。", usage: "学员按示范整理自己的工作需求。", difference: "", delivery: "配有可编辑练习文件。", limitations: "需要自行完成练习。", speakerExperience: "" };
  const saved = await f.saveProduct({ sku: "WITH-WRITING-MATERIAL", status: "confirmed", publicData: { ...f.productInput.publicData, copyFacts } });
  const row = f.sqlite.prepare("SELECT public_json FROM ecommerce_product_versions WHERE id=?").get(saved.versionId);
  assert.deepEqual(JSON.parse(row.public_json).copyFacts, copyFacts);
});
