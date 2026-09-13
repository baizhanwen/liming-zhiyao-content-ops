import { z } from "zod";
import { getD1 } from "../../../../db/runtime";
import { authorize, auditStatement, endpoint, enabledGuard, EcommerceError, queryScope, readInput, requireChanged } from "../../../../lib/ecommerce/access";
import { caseSchema, confirmationSchema, scopeSchema } from "../../../../lib/ecommerce/contracts";
import { hashJson } from "../../../../lib/ecommerce/products";
import { quoteLocated, readCaseSource } from "../../../../lib/ecommerce/cases";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return endpoint(async () => {
    const access = await authorize(request, queryScope(request)), scope = [access.organizationId, access.projectId], db = getD1();
    const [cases, references] = await Promise.all([
      db.prepare("SELECT c.*,r.status AS reference_status FROM ecommerce_case_profiles c INNER JOIN project_video_references r ON r.id=c.reference_id AND r.organization_id=c.organization_id AND r.project_id=c.project_id WHERE c.organization_id=? AND c.project_id=? ORDER BY c.created_at DESC LIMIT 100").bind(...scope).all(),
      db.prepare(`SELECT r.id AS reference_id,v.id AS video_id,v.title,a.id AS analysis_id,a.created_at AS analyzed_at FROM project_video_references r
        INNER JOIN video_library_entries l ON l.id=r.library_entry_id AND l.organization_id=r.organization_id
        INNER JOIN videos v ON v.id=l.source_video_id AND v.organization_id=l.organization_id
        INNER JOIN video_analyses a ON a.video_id=v.id AND a.organization_id=v.organization_id
        WHERE r.organization_id=? AND r.project_id=? AND r.status='active' AND r.purpose='benchmark' AND v.deleted_at IS NULL AND v.status!='archived' ORDER BY a.created_at DESC LIMIT 100`).bind(...scope).all(),
    ]);
    return Response.json({ cases: cases.results, references: references.results });
  });
}
export async function POST(request: Request) {
  return endpoint(async () => {
    const input = await readInput(request, caseSchema), access = await authorize(request, input, true);
    const source = await readCaseSource(access, input.referenceId, input.analysisId, input.transcriptId);
    if (!quoteLocated(input.sourceQuote, source.sourceText)) throw new EcommerceError("CASE_QUOTE_NOT_FOUND", "引用片段无法在所选分析或转写中定位。", 409);
    const id = crypto.randomUUID(), now = new Date().toISOString(), scope = [access.organizationId, access.projectId];
    const { organizationId, projectId, ...body } = input; void organizationId; void projectId;
    const result = await getD1().batch([
      getD1().prepare(`INSERT INTO ecommerce_case_profiles (id,organization_id,project_id,reference_id,video_id,analysis_id,transcript_id,body_json,source_snapshot,content_hash,status,confirmed_by,confirmed_at,created_by,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${enabledGuard} AND EXISTS(SELECT 1 FROM project_video_references WHERE id=? AND organization_id=? AND project_id=? AND status='active' AND purpose='benchmark')`)
        .bind(id, ...scope, input.referenceId, source.video_id, input.analysisId, input.transcriptId, JSON.stringify(body), input.sourceQuote, await hashJson(body), input.status, input.status === "confirmed" ? access.userId : null, input.status === "confirmed" ? now : null, access.userId, now, now, ...scope, input.referenceId, ...scope),
      auditStatement(access, "ecommerce.case.created", id),
    ]); requireChanged(result);
    return Response.json({ case: { id, revision: 1 } }, { status: 201 });
  });
}
const stateSchema = scopeSchema.extend({ id: z.string().min(1).max(100), revision: z.number().int().min(1), status: confirmationSchema }).strict();
export async function PATCH(request: Request) {
  return endpoint(async () => {
    const input = await readInput(request, stateSchema), access = await authorize(request, input, true), scope = [access.organizationId, access.projectId], db = getD1();
    const row = await db.prepare("SELECT reference_id,analysis_id,transcript_id,source_snapshot FROM ecommerce_case_profiles WHERE id=? AND organization_id=? AND project_id=?").bind(input.id, ...scope).first<{ reference_id: string; analysis_id: string; transcript_id: string | null; source_snapshot: string }>();
    if (!row) throw new EcommerceError("CASE_UNAVAILABLE", "案例不可用。", 404);
    if (input.status === "confirmed") {
      const source = await readCaseSource(access, row.reference_id, row.analysis_id, row.transcript_id);
      if (!quoteLocated(row.source_snapshot, source.sourceText)) throw new EcommerceError("CASE_QUOTE_NOT_FOUND", "原引用已无法定位。", 409);
    }
    const now = new Date().toISOString();
    const result = await db.batch([
      db.prepare(`UPDATE ecommerce_case_profiles SET status=?,revision=revision+1,confirmed_by=?,confirmed_at=?,updated_at=? WHERE id=? AND organization_id=? AND project_id=? AND revision=? AND ${enabledGuard}`)
        .bind(input.status, input.status === "confirmed" ? access.userId : null, input.status === "confirmed" ? now : null, now, input.id, ...scope, input.revision, ...scope),
      auditStatement(access, "ecommerce.case.status", input.id, { status: input.status }),
    ]); requireChanged(result);
    return Response.json({ case: { id: input.id, revision: input.revision + 1, status: input.status } });
  });
}
