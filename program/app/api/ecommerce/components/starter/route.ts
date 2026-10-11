import { z } from "zod";
import { getD1 } from "../../../../../db/runtime";
import { authorize, auditStatement, adminWriteGuard, adminWriteBindings, commitMutation, endpoint, EcommerceError, queryScope, readInput } from "../../../../../lib/ecommerce/access";
import { scopeSchema } from "../../../../../lib/ecommerce/contracts";
import { ECOMMERCE_STARTER_CARDS, ECOMMERCE_STARTER_VERSION } from "../../../../../lib/ecommerce/starter-catalog";
import { hashJson } from "../../../../../lib/ecommerce/products";

export const dynamic = "force-dynamic";
const schema = scopeSchema.extend({ keys: z.array(z.string().min(1).max(100)).min(1).max(30), confirm: z.literal(true) }).strict();
export async function GET(request: Request) {
  return endpoint(async () => {
    const access = await authorize(request, queryScope(request));
    return Response.json({ version: ECOMMERCE_STARTER_VERSION, cards: ECOMMERCE_STARTER_CARDS, canImport: ECOMMERCE_STARTER_CARDS.length > 0 && access.organizationRole === "admin" && Boolean(access.settings.enabled) });
  });
}
export async function POST(request: Request) {
  return endpoint(async () => {
    const input = await readInput(request, schema), access = await authorize(request, input, true);
    if (access.organizationRole !== "admin") throw new EcommerceError("ADMIN_REQUIRED", "基础方法由公司管理员确认后导入当前空间。", 403);
    const keys = [...new Set(input.keys)];
    if (keys.some(key => !ECOMMERCE_STARTER_CARDS.some(c => c.key === key))) throw new EcommerceError("UNKNOWN_STARTER", "基础方法已变更，请刷新后选择。", 400);
    const db = getD1(), now = new Date().toISOString(), scope = [access.organizationId, access.projectId];
    const statements: D1PreparedStatement[] = [];
    for (const entry of ECOMMERCE_STARTER_CARDS.filter(c => keys.includes(c.key))) {
      const body = entry.card;
      // Stable identity prevents reimport from overwriting or duplicating an
      // administrator's later edits, even if they changed the source metadata.
      const id = `ec-starter-${await hashJson({ scope, version: ECOMMERCE_STARTER_VERSION, key: entry.key })}`;
      const sourceKey = await hashJson({ source: body.sourceLocator, version: body.sourceVersion, kind: body.kind, name: body.name });
      statements.push(
        db.prepare(`INSERT INTO ecommerce_components (id,organization_id,project_id,scope,name,kind,status,source_key,created_by,updated_by,created_at,updated_at)
          SELECT ?,?,?,'project',?,?,'confirmed',?,?,?,?,? WHERE ${adminWriteGuard}
          ON CONFLICT DO NOTHING`).bind(id, ...scope, body.name, body.kind, sourceKey, access.userId, access.userId, now, now, ...adminWriteBindings(access)),
        db.prepare(`INSERT INTO ecommerce_component_versions (id,component_id,version,body_json,content_hash,confirmed_by,confirmed_at,created_by,created_at)
          SELECT ?,?,1,?,?,?,?,?,? WHERE changes()=1`).bind(crypto.randomUUID(), id, JSON.stringify(body), await hashJson(body), access.userId, now, access.userId, now),
        auditStatement(access, "ecommerce.component.starter_imported", id, { key: entry.key, version: ECOMMERCE_STARTER_VERSION, methods: entry.methods }),
      );
    }
    const results = await commitMutation(request, access, statements, { admin: true });
    const imported = results.filter((_, i) => i % 3 === 0).reduce((sum, r) => sum + Number(r.meta.changes ?? 0), 0);
    return Response.json({ imported, skipped: keys.length - imported, version: ECOMMERCE_STARTER_VERSION });
  });
}
