import { getD1 } from "../../../../db/runtime";
import { authorize, endpoint, queryScope } from "../../../../lib/ecommerce/access";
import { readCoreContentStrategy, strategyForTask } from "../../../../lib/content-strategy-policy";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return endpoint(async () => {
    const access = await authorize(request, queryScope(request)), db = getD1(), scope = [access.organizationId, access.projectId];
    const [products, knowledge, accounts, strategy] = await Promise.all([
      db.prepare(`SELECT p.id,p.name,p.sku,p.status,p.current_version,v.id AS version_id,v.version,v.public_json,v.confirmed_at
        FROM ecommerce_products p JOIN ecommerce_product_versions v ON v.product_id=p.id AND v.organization_id=p.organization_id AND v.project_id=p.project_id
        WHERE p.organization_id=? AND p.project_id=? ORDER BY p.updated_at DESC,v.version DESC LIMIT 500`).bind(...scope).all(),
      db.prepare(`SELECT k.id,k.title,k.current_version,v.body FROM knowledge_items k JOIN knowledge_item_versions v ON v.item_id=k.id AND v.organization_id=k.organization_id AND v.project_id=k.project_id AND v.version=k.current_version
        WHERE k.organization_id=? AND k.project_id=? AND k.status='confirmed' AND k.deleted_at IS NULL ORDER BY k.updated_at DESC LIMIT 200`).bind(...scope).all(),
      db.prepare("SELECT id,display_name,handle,platform,profile_url FROM social_accounts WHERE organization_id=? AND project_id=? AND account_type='owned' AND status='active' ORDER BY display_name LIMIT 100").bind(...scope).all(),
      readCoreContentStrategy(db, access),
    ]);
    return Response.json({ products: products.results, knowledge: knowledge.results, accounts: accounts.results, strategy: strategyForTask(strategy, "电商任务") });
  });
}
