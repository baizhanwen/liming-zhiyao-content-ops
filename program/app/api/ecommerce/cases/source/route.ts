import { getD1 } from "../../../../../db/runtime";
import { authorize, endpoint, queryScope } from "../../../../../lib/ecommerce/access";
import { readCaseSource } from "../../../../../lib/ecommerce/cases";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return endpoint(async () => {
    const access = await authorize(request, queryScope(request)), query = new URL(request.url).searchParams;
    const source = await readCaseSource(access, query.get("referenceId") || "", query.get("analysisId") || "", query.get("transcriptId"));
    const transcripts = await getD1().prepare("SELECT id,created_at FROM video_transcripts WHERE video_id=? AND organization_id=? ORDER BY created_at DESC LIMIT 30").bind(source.video_id, access.organizationId).all();
    return Response.json({ title: source.title, sourceText: source.sourceText, transcripts: transcripts.results });
  });
}
