import { getD1 } from "../../../../db/runtime";
import { authorize, endpoint, queryScope, readInput } from "../../../../lib/ecommerce/access";
import { productSchema } from "../../../../lib/ecommerce/contracts";
import { saveProduct } from "../../../../lib/ecommerce/products";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return endpoint(async () => {
    const access = await authorize(request, queryScope(request));
    const rows = await getD1().prepare(`SELECT p.*, v.id AS version_id, v.public_json, v.internal_json, v.confirmed_by, v.confirmed_at
      FROM ecommerce_products p INNER JOIN ecommerce_product_versions v ON v.product_id=p.id AND v.version=p.current_version AND v.organization_id=p.organization_id AND v.project_id=p.project_id
      WHERE p.organization_id=? AND p.project_id=? ORDER BY p.updated_at DESC LIMIT 200`).bind(access.organizationId, access.projectId).all();
    return Response.json({ products: rows.results });
  });
}
export async function POST(request: Request) {
  return endpoint(async () => {
    const input = await readInput(request, productSchema), access = await authorize(request, input, true);
    return Response.json({ product: await saveProduct(access, input) }, { status: input.id ? 200 : 201 });
  });
}
