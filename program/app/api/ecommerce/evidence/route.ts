import { getD1 } from "../../../../db/runtime";
import { authorize, auditStatement, endpoint, enabledGuard, EcommerceError, queryScope, readInput, requireChanged } from "../../../../lib/ecommerce/access";
import { confirmationSchema, evidenceSchema, scopeSchema } from "../../../../lib/ecommerce/contracts";
import { hashJson } from "../../../../lib/ecommerce/products";
import { z } from "zod";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return endpoint(async () => {
    const access = await authorize(request, queryScope(request));
    const productId = new URL(request.url).searchParams.get("productId") || "";
    const rows = await getD1().prepare("SELECT * FROM ecommerce_evidence WHERE organization_id=? AND project_id=? AND product_id=? ORDER BY created_at DESC LIMIT 200")
      .bind(access.organizationId, access.projectId, productId).all();
    return Response.json({ evidence: rows.results });
  });
}
export async function POST(request: Request) {
  return endpoint(async () => {
    const input = await readInput(request, evidenceSchema), access = await authorize(request, input, true), db = getD1();
    const scope = [access.organizationId, access.projectId];
    const product = await db.prepare("SELECT id FROM ecommerce_products WHERE id=? AND organization_id=? AND project_id=?").bind(input.productId, ...scope).first();
    if (!product) throw new EcommerceError("PRODUCT_UNAVAILABLE", "商品不可用。", 404);
    if (input.mediaAssetId && !await db.prepare("SELECT id FROM media_assets WHERE id=? AND organization_id=? AND project_id=?").bind(input.mediaAssetId, ...scope).first())
      throw new EcommerceError("MEDIA_UNAVAILABLE", "证据附件不可用。", 409);
    if (input.status === "confirmed" && input.validUntil && Date.parse(input.validUntil) <= Date.now())
      throw new EcommerceError("EVIDENCE_EXPIRED", "过期证据不能确认。", 409);
    const id = crypto.randomUUID(), now = new Date().toISOString();
    const body = { title: input.title, kind: input.kind, body: input.body, sourceLocator: input.sourceLocator, mediaAssetId: input.mediaAssetId, conditions: input.conditions, validUntil: input.validUntil };
    const result = await db.batch([
      db.prepare(`INSERT INTO ecommerce_evidence (id,organization_id,project_id,product_id,title,kind,body_json,content_hash,media_asset_id,valid_until,status,confirmed_by,confirmed_at,created_by,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${enabledGuard}`)
        .bind(id, ...scope, input.productId, input.title, input.kind, JSON.stringify(body), await hashJson(body), input.mediaAssetId, input.validUntil, input.status, input.status === "confirmed" ? access.userId : null, input.status === "confirmed" ? now : null, access.userId, now, now, ...scope),
      auditStatement(access, "ecommerce.evidence.created", id),
    ]); requireChanged(result);
    return Response.json({ evidence: { id, revision: 1 } }, { status: 201 });
  });
}
const stateSchema = scopeSchema.extend({ id: z.string().min(1).max(100), revision: z.number().int().min(1), status: confirmationSchema }).strict();
export async function PATCH(request: Request) {
  return endpoint(async () => {
    const input = await readInput(request, stateSchema), access = await authorize(request, input, true), now = new Date().toISOString();
    const scope = [access.organizationId, access.projectId];
    const result = await getD1().batch([
      getD1().prepare(`UPDATE ecommerce_evidence SET status=?,revision=revision+1,confirmed_by=?,confirmed_at=?,updated_at=? WHERE id=? AND organization_id=? AND project_id=? AND revision=? AND (? != 'confirmed' OR valid_until IS NULL OR julianday(valid_until) > julianday(?)) AND ${enabledGuard}`)
        .bind(input.status, input.status === "confirmed" ? access.userId : null, input.status === "confirmed" ? now : null, now, input.id, ...scope, input.revision, input.status, now, ...scope),
      auditStatement(access, "ecommerce.evidence.status", input.id, { status: input.status }),
    ]); requireChanged(result, "证据已过期、状态改变或不可用，请刷新核对。");
    return Response.json({ evidence: { id: input.id, revision: input.revision + 1, status: input.status } });
  });
}
