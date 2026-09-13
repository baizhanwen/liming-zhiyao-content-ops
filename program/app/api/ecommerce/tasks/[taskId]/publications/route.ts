import { authorize, endpoint, readInput } from "../../../../../../lib/ecommerce/access";
import { publicationSchema } from "../../../../../../lib/ecommerce/contracts";
import { savePublication } from "../../../../../../lib/ecommerce/results";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  return endpoint(async () => {
    const input = await readInput(request, publicationSchema), access = await authorize(request, input, true);
    return Response.json({ publication: await savePublication(access, (await context.params).taskId, input) }, { status: 201 });
  });
}
