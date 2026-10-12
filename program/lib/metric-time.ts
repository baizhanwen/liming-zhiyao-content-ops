// Keep sub-millisecond fractions: Date supplies the UTC calendar/second while
// the original fraction is retained, rather than truncating two instants together.
export function metricUtc(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999) return null;
  const digits = /\.([0-9]+)(?:Z|[+-]\d{2}:\d{2})?$/.exec(value)?.[1] || "";
  const fraction = digits.replace(/0+$/, "").padEnd(3, "0");
  return date.toISOString().slice(0, 19) + "." + fraction + "Z";
}
export function metricTimeKey(value: string) { return metricUtc(value)?.slice(0, -1) || ""; }

// SQLite's date functions round fractional seconds. Strip the fraction before
// timezone conversion, then restore all digits for exact equality and ordering.
// Expressions are repository-owned SQL, never interpolated user input.
export function metricUtcSql(expression: string) {
  const dot = `instr(${expression},'.')`, tail = `substr(${expression},${dot}+1)`;
  const size = `(CASE WHEN instr(${tail},'Z')>0 THEN instr(${tail},'Z') WHEN instr(${tail},'+')>0 THEN instr(${tail},'+') WHEN instr(${tail},'-')>0 THEN instr(${tail},'-') ELSE length(${tail})+1 END)-1`;
  const whole = `(CASE WHEN ${dot}>0 THEN substr(${expression},1,${dot}-1)||substr(${tail},(${size})+1) ELSE ${expression} END)`;
  const fraction = `(CASE WHEN ${dot}>0 THEN rtrim(substr(${tail},1,${size}),'0') ELSE '' END)`;
  return `(strftime('%Y-%m-%dT%H:%M:%S',${whole})||'.'||substr(${fraction}||'000',1,max(3,length(${fraction})))||'Z')`;
}
export function metricOrderSql(expression: string) { return `rtrim(${metricUtcSql(expression)},'Z')`; }
