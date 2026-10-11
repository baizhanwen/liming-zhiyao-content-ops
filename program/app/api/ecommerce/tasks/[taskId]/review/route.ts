import { authorize, endpoint, readInput } from "../../../../../../lib/ecommerce/access";
import { reviewEcommerce, reviewInputSchema } from "../../../../../../lib/ecommerce/workflow";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  return endpoint(async () => {
    const input = await readInput(request, reviewInputSchema), access = await authorize(request, input, true);
    return Response.json({ task: await reviewEcommerce(request, access, (await context.params).taskId, input) });
  });
}
