const missingMetricTokens = new Set(["", "-", "--", "—", "–", "n/a", "na", "null", "暂无", "无数据"]);

export function isMissingMetricCell(value: unknown) {
  return missingMetricTokens.has(String(value ?? "").trim().toLowerCase());
}

export function metricNumberCell(value: unknown) {
  if (isMissingMetricCell(value)) return 0;
  const result = Number(String(value).replaceAll(",", "").trim());
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`无效数字，计数必须为非负整数：${String(value)}`);
  return result;
}

export function signedMetricNumberCell(value: unknown) {
  if (isMissingMetricCell(value)) return 0;
  const result = Number(String(value).replaceAll(",", "").trim());
  if (!Number.isSafeInteger(result)) throw new Error(`无效有符号数字，计数必须为整数：${String(value)}`);
  return result;
}

export function percentMetricCell(value: unknown) {
  if (isMissingMetricCell(value)) return undefined;
  const raw = String(value).replaceAll("％", "%").replaceAll(",", "").trim();
  const result = Number(raw.replaceAll("%", ""));
  const normalized = !raw.includes("%") && result >= 0 && result <= 1 ? result * 100 : result;
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 100) throw new Error(`百分比必须在 0%～100%：${String(value)}`);
  return normalized;
}

export function watchMetricMilliseconds(value: unknown) {
  if (isMissingMetricCell(value)) return undefined;
  const raw = String(value).trim();
  const parts = raw.split(":");
  const seconds = parts.length === 2
    ? Number(parts[0]) * 60 + Number(parts[1])
    : parts.length === 1 ? Number(raw.replaceAll(",", "")) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`无效平均播放时长：${String(value)}`);
  return Math.round(seconds * 1000);
}
