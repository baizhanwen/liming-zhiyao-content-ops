import { getD1 } from "../../../../db/runtime";
import { authorize, auditStatement, adminAccessBindings, adminAccessGuard, commitMutation, endpoint, EcommerceError, queryScope, readInput, readSettings, requireChanged } from "../../../../lib/ecommerce/access";
import { settingsSchema } from "../../../../lib/ecommerce/contracts";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return endpoint(async () => {
    const access = await authorize(request, queryScope(request));
    return Response.json({ settings: access.settings, canManage: access.organizationRole === "admin" });
  });
}
export async function PUT(request: Request) {
  return endpoint(async () => {
    const input = await readInput(request, settingsSchema), access = await authorize(request, input);
    if (access.organizationRole !== "admin") throw new EcommerceError("ADMIN_REQUIRED", "只有公司管理员可以启用电商素材。", 403);
    const now = new Date().toISOString(), db = getD1();
    const result = await commitMutation(request, access, [
      db.prepare(`INSERT INTO ecommerce_project_settings (organization_id, project_id, enabled, revision, max_concurrent, monthly_call_limit, updated_by, updated_at)
        SELECT ?, ?, ?, 1, ?, ?, ?, ? WHERE ? = 0 AND ${adminAccessGuard}
        ON CONFLICT(organization_id, project_id) DO NOTHING`).bind(access.organizationId, access.projectId, Number(input.enabled), input.maxConcurrent, input.monthlyCallLimit, access.userId, now, input.revision, ...adminAccessBindings(access)),
      auditStatement(access, "ecommerce.settings.created", access.projectId, { enabled: input.enabled }),
    ], { admin: true, enabled: false });
    if (input.revision === 0) requireChanged(result);
    else {
      const updated = await commitMutation(request, access, [
        db.prepare(`UPDATE ecommerce_project_settings SET enabled = ?, revision = revision + 1, max_concurrent = ?, monthly_call_limit = ?, updated_by = ?, updated_at = ? WHERE organization_id = ? AND project_id = ? AND revision = ? AND ${adminAccessGuard}`)
          .bind(Number(input.enabled), input.maxConcurrent, input.monthlyCallLimit, access.userId, now, access.organizationId, access.projectId, input.revision, ...adminAccessBindings(access)),
        auditStatement(access, "ecommerce.settings.updated", access.projectId, { enabled: input.enabled }),
      ], { admin: true, enabled: false }); requireChanged(updated);
    }
    return Response.json({ settings: await readSettings(access.organizationId, access.projectId) });
  });
}
