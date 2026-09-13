import { z } from "zod";
import { getD1 } from "../../../../db/runtime";
import { authorize, auditStatement, enabledGuard, endpoint, readInput, requireChanged } from "../../../../lib/ecommerce/access";
import { scopeSchema } from "../../../../lib/ecommerce/contracts";
import { hashJson } from "../../../../lib/ecommerce/products";

export const dynamic = "force-dynamic";
const schema = scopeSchema.extend({ displayName: z.string().trim().min(1).max(200), handle: z.string().trim().min(1).max(200), platform: z.literal("douyin"),
  profileUrl: z.union([z.url().max(2000).refine(v => /^https?:\/\//.test(v)), z.literal("")]).default(""), confirmOwned: z.literal(true) }).strict();
export async function POST(request: Request) {
  return endpoint(async () => {
    const input = await readInput(request, schema), access = await authorize(request, input, true), db = getD1(), scope = [access.organizationId, access.projectId];
    const existing = await db.prepare("SELECT id FROM social_accounts WHERE organization_id=? AND project_id=? AND platform=? AND handle=? AND account_type='owned' AND status='active'").bind(...scope, input.platform, input.handle).first();
    if (existing) return Response.json({ account: existing, duplicate: true });
    const id = `ec-account-${await hashJson({ scope, platform: input.platform, handle: input.handle })}`, now = new Date().toISOString();
    const result = await db.batch([
      db.prepare(`INSERT INTO social_accounts (id,organization_id,project_id,platform,account_type,display_name,handle,profile_url,status,created_by,updated_by,created_at,updated_at)
        SELECT ?,?,?,?,'owned',?,?,?,'active',?,?,?,? WHERE ${enabledGuard} ON CONFLICT(id) DO NOTHING`)
        .bind(id, ...scope, input.platform, input.displayName, input.handle, input.profileUrl || null, access.userId, access.userId, now, now, ...scope),
      auditStatement(access, "ecommerce.account.registered", id, { platform: input.platform, ownershipConfirmed: true }),
    ]);
    if (!result[0].meta.changes) {
      const repeated = await db.prepare("SELECT id FROM social_accounts WHERE id=? AND organization_id=? AND project_id=? AND account_type='owned' AND status='active'").bind(id, ...scope).first();
      if (repeated) return Response.json({ account: repeated, duplicate: true });
      requireChanged(result);
    }
    return Response.json({ account: { id }, duplicate: false }, { status: 201 });
  });
}
