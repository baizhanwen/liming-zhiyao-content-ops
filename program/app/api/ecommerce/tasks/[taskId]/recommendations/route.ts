import { authorize, endpoint, queryScope } from "../../../../../../lib/ecommerce/access";
import { buildEcommerceContext } from "../../../../../../lib/ecommerce/context";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  return endpoint(async () => {
    const access = await authorize(request, queryScope(request));
    const result = await buildEcommerceContext(access, (await context.params).taskId);
    return Response.json({ ready: result.ready, missing: result.missing, copyReadiness: result.copyReadiness, candidates: result.input.candidates, rejected: result.rejected, cases: result.input.cases,
      strategy: result.input.strategy, sources: result.manifest, inputHash: result.inputHash, caseNotice: result.input.cases.length ? "参考案例仅用于结构和表达机制" : result.input.candidates.length ? "将依据所选方法和商品资料生成完整文案" : "无需参考视频，将依据内容方法论和商品资料生成完整文案" });
  });
}
