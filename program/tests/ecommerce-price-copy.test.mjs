import assert from "node:assert/strict";
import test from "node:test";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";

async function pricedFixture(t, extra = {}) {
  let priceEvidenceId;
  const f = await ecommerceGenerationFixture(t, { respond: ({ stage, result, payload }) => {
    if (["draft", "repair"].includes(stage)) {
      const segment = result.segments.find(item => item.role === "evidence");
      segment.script = "这款合成杯售价100元。先看清商品的具体信息，再根据自己的使用需要选择。";
      segment.evidenceIds = [priceEvidenceId];
      const fields = { claim: "claimIds", evidence: "evidenceIds", component: "componentIds", knowledge: "knowledgeIds", case: "caseIds" };
      result.applications = payload.context.sources.map(source => {
        const segments = result.segments.filter(item => item[fields[source.type]].includes(source.id));
        return { sourceType: source.type, sourceId: source.id, used: segments.length > 0, sourceQuote: segments.length ? source.text.split("\n")[0] : "", segmentIds: segments.map(item => item.id), draftQuote: segments[0]?.script ?? "", reason: segments.length ? "依据已确认价格资料写入" : "本次不采用", notTransferred: "" };
      });
    }
    if (stage === "review") result.claimChecks = payload.draft.segments.filter(segment => segment.claimIds.length).map(segment => ({ segmentId: segment.id, statement: segment.script, supported: true, sourceIds: ["rotation", priceEvidenceId], reason: "确认价与选中的价格资料一致，没有添加促销承诺" }));
    return result;
  } });
  const evidence = await f.route("evidence").POST(f.request("POST", { productId: f.product.id, title: "合成价格资料", kind: "offer", body: "当前录入价格100元。", sourceLocator: "合成测试价格表，不是真实商业价格", status: "confirmed" }));
  assert.equal(evidence.status, 201, await evidence.clone().text());
  priceEvidenceId = (await evidence.json()).evidence.id;
  const product = await f.saveProduct({ id: f.product.id, revision: 2, status: "confirmed", publicData: { ...f.productInput.publicData, priceCents: 10000, currency: "CNY", offer: "", offerValidUntil: null, ...extra, claims: [{ id: "rotation", kind: "offer", statement: "当前录入价格100元", allowedExpression: "当前录入价格100元，不声称优惠或限时活动", evidenceIds: [priceEvidenceId], status: "confirmed" }] } });
  f.sqlite.prepare("UPDATE ecommerce_tasks SET product_version_id=?,brief_json=? WHERE id=?").run(product.versionId, JSON.stringify({ ...f.brief, evidenceIds: [priceEvidenceId] }), f.task.id);
  return f;
}

test("an evidenced ordinary price can be written without inventing a promotion or requiring expiry", async t => {
  const f = await pricedFixture(t);
  const response = await f.generate();
  assert.equal(response.status, 201, await response.clone().text());
  const context = f.calls[0].payload.context;
  assert.deepEqual(context.product.price.amountCents, 10000);
  assert.equal(context.product.price.currency, "CNY");
  assert.equal(context.product.offer.validUntil, null);
  assert.equal("sku" in context.product, false, "internal product numbering is not copy input");
  const pack = (await response.json()).version.pack;
  assert.match(pack.segments.map(segment => segment.script).join(""), /100元/);
  assert.doesNotMatch(pack.segments.map(segment => segment.script).join(""), /限时|立减|打折/);
});

test("a promotion still requires a recorded valid-until date", async t => {
  const f = await pricedFixture(t, { offer: "限时活动价格100元" });
  const response = await f.generate();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "OFFER_UNAVAILABLE");
  assert.equal(f.calls.length, 0);
});

for (const offer of ["", "限时活动价格100元"]) test(`an explicitly expired ${offer ? "promotion" : "ordinary price"} cannot enter a new draft`, async t => {
  const f = await pricedFixture(t, { offer, offerValidUntil: "2020-01-01T00:00:00.000Z" });
  const response = await f.generate();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "OFFER_UNAVAILABLE");
  assert.equal(f.calls.length, 0);
});
