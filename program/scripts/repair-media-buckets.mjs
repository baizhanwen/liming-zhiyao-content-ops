import process from "node:process";

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function positiveInteger(value, fallback, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

const organizationId = valueAfter("--organization-id");
if (!organizationId) {
  console.error("用法：node scripts/repair-media-buckets.mjs --organization-id <UUID> [--base-url <URL>] [--batch-size 25] [--apply]");
  process.exit(2);
}

const baseUrl = (valueAfter("--base-url") || "http://127.0.0.1:3000").replace(/\/+$/, "");
const batchSize = positiveInteger(valueAfter("--batch-size"), 25, 50);
const dryRun = !process.argv.includes("--apply");
const cookie = process.env.MEDIA_REPAIR_COOKIE?.trim();
const totals = {};
let cursor = "";
let batches = 0;
let processed = 0;

for (;;) {
  const response = await fetch(baseUrl + "/api/operations/media-repair", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ organizationId, cursor, limit: batchSize, dryRun }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    console.error(JSON.stringify({ ok: false, status: response.status, body }, null, 2));
    process.exit(1);
  }

  batches += 1;
  processed += Number(body.processed ?? 0);
  for (const [status, count] of Object.entries(body.summary ?? {})) {
    totals[status] = (totals[status] ?? 0) + Number(count);
  }
  console.log(JSON.stringify({
    event: "media_repair_batch",
    batch: batches,
    dryRun,
    processed: body.processed,
    nextCursor: body.nextCursor,
    summary: body.summary,
  }));

  cursor = typeof body.nextCursor === "string" ? body.nextCursor : "";
  if (body.done || !cursor) break;
  if (batches >= 10_000) throw new Error("素材修复批次数异常，已安全停止。");
}

console.log(JSON.stringify({
  event: "media_repair_complete",
  ok: true,
  dryRun,
  batches,
  processed,
  totals,
  note: dryRun
    ? "当前为试跑，没有写入主桶。确认结果后增加 --apply 执行复制。"
    : "复制完成；历史桶对象未删除。",
}, null, 2));
