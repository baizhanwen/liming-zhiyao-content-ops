import { authorize, endpoint, readInput } from "../../../../../../lib/ecommerce/access";
import { controlRun, runControlSchema } from "../../../../../../lib/ecommerce/runs";

export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  return endpoint(async () => {
    const input = await readInput(request, runControlSchema);
    // Stopping work remains possible after the module is disabled.
    const access = await authorize(request, input);
    return Response.json(await controlRun(access, (await context.params).taskId, input));
  });
}
