import { authorize, endpoint, readInput } from "../../../../../../lib/ecommerce/access";
import { runSchema } from "../../../../../../lib/ecommerce/contracts";
import { generateEcommerce } from "../../../../../../lib/ecommerce/generation";

export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  return endpoint(async () => {
    const input = await readInput(request, runSchema), access = await authorize(request, input, true);
    const result = await generateEcommerce(request, access, (await context.params).taskId, input);
    return Response.json(result, { status: result.status });
  });
}
