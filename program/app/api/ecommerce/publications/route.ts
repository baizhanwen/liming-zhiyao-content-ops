import { getD1 } from "../../../../db/runtime";
import { authorize, endpoint, queryScope, EcommerceError } from "../../../../lib/ecommerce/access";
import type { EcommercePack } from "../../../../lib/ecommerce/contracts";
import type { ContextSource } from "../../../../lib/ecommerce/context";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return endpoint(async () => {
    const access = await authorize(request, queryScope(request));
    const publicationId = new URL(request.url).searchParams.get("publicationId");
    if (publicationId) {
      const row = await getD1().prepare(`SELECT p.id,p.task_id,p.version_id,v.version,v.pack_json,v.input_snapshot_json
        FROM ecommerce_publications p JOIN ecommerce_versions v ON v.id=p.version_id AND v.task_id=p.task_id AND v.organization_id=p.organization_id AND v.project_id=p.project_id
        WHERE p.id=? AND p.organization_id=? AND p.project_id=?`).bind(publicationId, access.organizationId, access.projectId)
        .first<{ id: string; task_id: string; version_id: string; version: number; pack_json: string; input_snapshot_json: string }>();
      if (!row) throw new EcommerceError("PUBLICATION_UNAVAILABLE", "发布记录不可用。", 404);
      const pack = JSON.parse(row.pack_json) as EcommercePack;
      const snapshot = JSON.parse(row.input_snapshot_json) as { product: { id: string; versionId: string; name: string; sku: string }; sources: ContextSource[] };
      return Response.json({ trace: {
        publicationId: row.id, taskId: row.task_id, versionId: row.version_id, version: row.version,
        title: pack.title, product: { id: snapshot.product.id, versionId: snapshot.product.versionId, name: snapshot.product.name, sku: snapshot.product.sku },
        applications: pack.applications.filter(a => a.used).map(a => ({ ...a, source: snapshot.sources.find(s => s.id === a.sourceId && s.type === a.sourceType) })),
      } });
    }
    const result = await getD1().prepare(`SELECT p.*,t.title,v.version,product.name AS product_name,product.sku,a.display_name AS account_name
      FROM ecommerce_publications p JOIN ecommerce_tasks t ON t.id=p.task_id AND t.organization_id=p.organization_id AND t.project_id=p.project_id
      JOIN ecommerce_versions v ON v.id=p.version_id AND v.organization_id=p.organization_id AND v.project_id=p.project_id
      JOIN ecommerce_product_versions product ON product.id=v.product_version_id AND product.organization_id=p.organization_id AND product.project_id=p.project_id
      JOIN social_accounts a ON a.id=p.account_id AND a.organization_id=p.organization_id AND a.project_id=p.project_id
      WHERE p.organization_id=? AND p.project_id=? ORDER BY p.published_at DESC LIMIT 300`).bind(access.organizationId, access.projectId).all();
    return Response.json({ publications: result.results });
  });
}
