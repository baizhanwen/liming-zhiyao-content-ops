import { getD1 } from "../../../../db/runtime";
import { authorize, endpoint, queryScope, readInput } from "../../../../lib/ecommerce/access";
import { metricsSchema } from "../../../../lib/ecommerce/contracts";
import { metricSummary, saveMetricSnapshot } from "../../../../lib/ecommerce/results";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return endpoint(async () => {
    const access = await authorize(request, queryScope(request)), publicationId = new URL(request.url).searchParams.get("publicationId") || "";
    const result = await getD1().prepare(`SELECT m.*,p.task_id,p.version_id,v.product_id,v.product_version_id,v.source_manifest_json,
      EXISTS(SELECT 1 FROM ecommerce_metric_snapshots next WHERE next.replaces_id=m.id) AS superseded
      FROM ecommerce_metric_snapshots m JOIN ecommerce_publications p ON p.id=m.publication_id AND p.organization_id=m.organization_id AND p.project_id=m.project_id
      JOIN ecommerce_versions v ON v.id=p.version_id AND v.organization_id=p.organization_id AND v.project_id=p.project_id
      WHERE m.organization_id=? AND m.project_id=? AND (?='' OR m.publication_id=?) ORDER BY m.observed_at DESC,m.created_at DESC LIMIT 200`)
      .bind(access.organizationId, access.projectId, publicationId, publicationId).all<{ body_json: string }>();
    return Response.json({ snapshots: result.results.map(row => ({ ...row, summary: metricSummary(metricsSchema.parse(JSON.parse(row.body_json))) })), notice: "每行是一份累计快照，不能将快照相加。" });
  });
}
export async function POST(request: Request) {
  return endpoint(async () => {
    const input = await readInput(request, metricsSchema), access = await authorize(request, input, true);
    const snapshot = await saveMetricSnapshot(request, access, input);
    return Response.json({ snapshot }, { status: snapshot.duplicate ? 200 : 201 });
  });
}
