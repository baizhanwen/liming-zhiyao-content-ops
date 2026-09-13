export async function readApiError(response: Response, fallback = "请求没有完成，请稍后重试。") {
  const body = await response.json().catch(() => null) as { error?: { message?: unknown } } | null;
  return typeof body?.error?.message === "string" && body.error.message ? body.error.message : fallback;
}

const dateFormats = {
  dateTime: new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  date: new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }),
  fullDate: new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }),
};

export function formatClientDate(value: string | null, format: keyof typeof dateFormats = "dateTime", empty = "—") {
  if (!value) return empty;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? empty : dateFormats[format].format(date);
}
