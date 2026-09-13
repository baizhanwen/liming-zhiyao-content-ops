import { getD1 } from "../../../../db/runtime";
import { authorize, auditStatement, endpoint, enabledGuard, EcommerceError, queryScope, readInput, requireChanged } from "../../../../lib/ecommerce/access";
import { componentSchema } from "../../../../lib/ecommerce/contracts";
import { hashJson } from "../../../../lib/ecommerce/products";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return endpoint(async () => {
    const access = await authorize(request, queryScope(request));
    const result = await getD1().prepare(`SELECT c.*,v.id AS version_id,v.body_json,v.content_hash,v.confirmed_by,v.confirmed_at FROM ecommerce_components c
      INNER JOIN ecommerce_component_versions v ON v.component_id=c.id AND v.version=c.current_version
      WHERE (c.scope='project' AND c.organization_id=? AND c.project_id=?) OR (c.scope='system' AND c.status='confirmed') ORDER BY c.kind,c.name LIMIT 300`)
      .bind(access.organizationId, access.projectId).all();
    return Response.json({ components: result.results });
  });
}
export async function POST(request: Request) {
  return endpoint(async () => {
    const input = await readInput(request, componentSchema), access = await authorize(request, input, true), db = getD1();
    if (input.id && input.revision < 1 || !input.id && input.revision !== 0) throw new EcommerceError("INVALID_REVISION", "组件版本无效。");
    if (input.status === "confirmed" && input.validUntil && Date.parse(input.validUntil) <= Date.now()) throw new EcommerceError("COMPONENT_EXPIRED", "过期组件不能确认。", 409);
    const id = input.id ?? crypto.randomUUID(), versionId = crypto.randomUUID(), now = new Date().toISOString(), scope = [access.organizationId, access.projectId];
    const { organizationId: _org, projectId: _project, id: _id, revision: _revision, ...body } = input;
    void _org; void _project; void _id; void _revision;
    const sourceKey = await hashJson({ source: input.sourceLocator, version: input.sourceVersion, kind: input.kind, name: input.name });
    const result = await db.batch([
      input.id
        ? db.prepare(`UPDATE ecommerce_components SET name=?,kind=?,status=?,revision=revision+1,current_version=current_version+1,source_key=?,updated_by=?,updated_at=? WHERE id=? AND organization_id=? AND project_id=? AND scope='project' AND revision=? AND ${enabledGuard}`)
          .bind(input.name, input.kind, input.status, sourceKey, access.userId, now, id, ...scope, input.revision, ...scope)
        : db.prepare(`INSERT INTO ecommerce_components (id,organization_id,project_id,scope,name,kind,status,source_key,created_by,updated_by,created_at,updated_at) SELECT ?,?,?,'project',?,?,?,?,?,?,?,? WHERE ${enabledGuard}`)
          .bind(id, ...scope, input.name, input.kind, input.status, sourceKey, access.userId, access.userId, now, now, ...scope),
      db.prepare(`INSERT INTO ecommerce_component_versions (id,component_id,version,body_json,content_hash,confirmed_by,confirmed_at,created_by,created_at)
        SELECT ?,id,current_version,?,?,?,?,?,? FROM ecommerce_components WHERE id=? AND organization_id=? AND project_id=? AND changes()=1`)
        .bind(versionId, JSON.stringify(body), await hashJson(body), input.status === "confirmed" ? access.userId : null, input.status === "confirmed" ? now : null, access.userId, now, id, ...scope),
      auditStatement(access, "ecommerce.component.saved", id, { versionId }),
    ]); requireChanged(result);
    return Response.json({ component: { id, versionId, revision: input.revision + 1 } }, { status: input.id ? 200 : 201 });
  });
}
