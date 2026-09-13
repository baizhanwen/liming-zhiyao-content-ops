import { getD1 } from "../../../../db/runtime";
import { authorize, endpoint, queryScope, readInput } from "../../../../lib/ecommerce/access";
import { taskSchema } from "../../../../lib/ecommerce/contracts";
import { readTask, saveTask } from "../../../../lib/ecommerce/tasks";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return endpoint(async () => {
    const access = await authorize(request, queryScope(request)), db = getD1(), scope = [access.organizationId, access.projectId];
    const taskId = new URL(request.url).searchParams.get("taskId");
    if (taskId) {
      const task = await readTask(access, taskId);
      const [versions, runs, publications, reviews] = await Promise.all([
        db.prepare("SELECT * FROM ecommerce_versions WHERE task_id=? AND organization_id=? AND project_id=? ORDER BY version DESC LIMIT 100").bind(taskId, ...scope).all(),
        db.prepare("SELECT * FROM ecommerce_generation_runs WHERE task_id=? AND organization_id=? AND project_id=? ORDER BY created_at DESC LIMIT 30").bind(taskId, ...scope).all(),
        db.prepare("SELECT * FROM ecommerce_publications WHERE task_id=? AND organization_id=? AND project_id=? ORDER BY published_at DESC LIMIT 100").bind(taskId, ...scope).all(),
        db.prepare("SELECT * FROM ecommerce_reviews WHERE task_id=? AND organization_id=? AND project_id=? ORDER BY created_at DESC LIMIT 100").bind(taskId, ...scope).all(),
      ]);
      return Response.json({ task, versions: versions.results, runs: runs.results, publications: publications.results, reviews: reviews.results });
    }
    const tasks = await db.prepare("SELECT t.*,p.name AS product_name,p.sku FROM ecommerce_tasks t INNER JOIN ecommerce_products p ON p.id=t.product_id AND p.organization_id=t.organization_id AND p.project_id=t.project_id WHERE t.organization_id=? AND t.project_id=? ORDER BY t.updated_at DESC LIMIT 200").bind(...scope).all();
    return Response.json({ tasks: tasks.results });
  });
}
export async function POST(request: Request) {
  return endpoint(async () => {
    const input = await readInput(request, taskSchema), access = await authorize(request, input, true);
    return Response.json({ task: await saveTask(access, input) }, { status: input.id ? 200 : 201 });
  });
}
