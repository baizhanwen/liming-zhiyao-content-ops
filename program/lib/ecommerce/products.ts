import { getD1, sha256Hex } from "../../db/runtime";
import { auditStatement, enabledGuard, EcommerceError, requireChanged, type EcommerceAccess } from "./access";
import type { ProductInput } from "./contracts";

export async function saveProduct(access: EcommerceAccess, input: ProductInput) {
  const db = getD1(), now = new Date().toISOString(), productId = input.id ?? crypto.randomUUID(), versionId = crypto.randomUUID();
  const scope = [access.organizationId, access.projectId];
  if (input.id && input.revision < 1 || !input.id && input.revision !== 0) throw new EcommerceError("INVALID_REVISION", "商品版本无效。", 400);
  // Validate every explicit association, even in a draft; no foreign evidence IDs may be persisted.
  for (const claim of input.publicData.claims) {
    for (const evidenceId of claim.evidenceIds) {
      const evidence = await db.prepare("SELECT status, valid_until FROM ecommerce_evidence WHERE id = ? AND product_id = ? AND organization_id = ? AND project_id = ?")
        .bind(evidenceId, productId, ...scope).first<{ status: string; valid_until: string | null }>();
      if (!evidence) throw new EcommerceError("EVIDENCE_UNAVAILABLE", "卖点引用了不可用的证据。", 409);
      if (claim.status === "confirmed" && (evidence.status !== "confirmed" || evidence.valid_until && Date.parse(evidence.valid_until) <= Date.now()))
        throw new EcommerceError("EVIDENCE_NOT_CONFIRMED", "确认卖点前，证据必须已确认且未过期。", 409);
    }
    if (claim.status === "confirmed" && (!claim.evidenceIds.length || claim.validUntil && Date.parse(claim.validUntil) <= Date.now()))
      throw new EcommerceError("CLAIM_UNVERIFIED", "已确认卖点需要有效证据和有效期。", 409);
  }
  const write = input.id
    ? db.prepare(`UPDATE ecommerce_products SET sku = ?, name = ?, status = ?, revision = revision + 1, current_version = current_version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND revision = ? AND ${enabledGuard}`)
      .bind(input.sku, input.name, input.status, access.userId, now, productId, ...scope, input.revision, ...scope)
    : db.prepare(`INSERT INTO ecommerce_products (id, organization_id, project_id, sku, name, status, created_by, updated_by, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${enabledGuard}`)
      .bind(productId, ...scope, input.sku, input.name, input.status, access.userId, access.userId, now, now, ...scope);
  const result = await db.batch([
    write,
    db.prepare(`INSERT INTO ecommerce_product_versions (id, organization_id, project_id, product_id, version, name, sku, public_json, internal_json, confirmed_by, confirmed_at, created_by, created_at)
      SELECT ?, organization_id, project_id, id, current_version, name, sku, ?, ?, ?, ?, ?, ? FROM ecommerce_products WHERE id = ? AND organization_id = ? AND project_id = ? AND changes() = 1`)
      .bind(versionId, JSON.stringify(input.publicData), JSON.stringify(input.internalData), input.status === "confirmed" ? access.userId : null, input.status === "confirmed" ? now : null, access.userId, now, productId, ...scope),
    auditStatement(access, "ecommerce.product.saved", productId, { versionId }),
  ]); requireChanged(result);
  return { id: productId, versionId, revision: input.revision + 1 };
}

export const hashJson = (value: unknown) => sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
