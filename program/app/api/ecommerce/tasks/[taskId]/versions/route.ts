import { authorize, endpoint, readInput } from "../../../../../../lib/ecommerce/access";
import { manualVersionSchema, saveManualVersion } from "../../../../../../lib/ecommerce/workflow";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  return endpoint(async () => {
    const input = await readInput(request, manualVersionSchema), access = await authorize(request, input, true);
    return Response.json({ version: await saveManualVersion(access, (await context.params).taskId, input) }, { status: 201 });
  });
}
