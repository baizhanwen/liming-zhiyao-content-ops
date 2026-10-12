const DAY = 86_400_000;
function offset(value: number) {
  if (!Number.isInteger(value) || Math.abs(value) > 14 * 60) throw new Error("导入时区无效。");
  return value * 60_000;
}
export function excelSerialDate(value: number, date1904 = false, offsetMinutes = 0) {
  if (!Number.isFinite(value) || value < (date1904 ? 0 : 1) || value >= (date1904 ? 2_957_004 : 2_958_466)) throw new Error("Excel 日期序列号无效或超出范围。");
  const day = Math.floor(value);
  if (!date1904 && day === 60) throw new Error("Excel 序列号 60 对应不存在的 1900-02-29，请修正日期。");
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, day < 60 ? 31 : 30);
  const date = new Date(epoch + Math.round(value * DAY) - offset(offsetMinutes));
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999) throw new Error("Excel 日期超出范围。");
  return date.toISOString();
}

// Parse only explicit calendar formats. Never let Date roll February 30 into
// March or interpret a local timestamp differently on two computers.
export function importDate(value: unknown, offsetMinutes = 0) {
  offset(offsetMinutes);
  if (typeof value === "number") return excelSerialDate(value, false, offsetMinutes);
  if (typeof value !== "string") throw new Error("日期为空或类型无效，请使用明确的日期时间。");
  const raw = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) return excelSerialDate(Number(raw), false, offsetMinutes);
  const clean = raw.replace(/^(\d{4})年(\d{1,2})月(\d{1,2})日/, "$1-$2-$3");
  const match = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(clean);
  if (!match || (!match[5] && match[9])) throw new Error("日期格式无效，请使用 YYYY-MM-DD 或带时区的 ISO 时间。");
  const year = Number(match[1]), month = Number(match[3]), day = Number(match[4]), hour = Number(match[5] || 0), minute = Number(match[6] || 0), second = Number(match[7] || 0), millisecond = Number((match[8] || "").padEnd(3, "0"));
  const wall = new Date(0); wall.setUTCFullYear(year, month - 1, day); wall.setUTCHours(hour, minute, second, millisecond);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 || wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day) throw new Error("日期或时分秒不存在，请修正后重试。");
  let zone = offsetMinutes;
  if (match[9] === "Z") zone = 0;
  else if (match[9]) {
    const hours = Number(match[9].slice(1, 3)), minutes = Number(match[9].slice(4));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes)) throw new Error("日期中的时区偏移无效。");
    zone = (match[9][0] === "-" ? -1 : 1) * (hours * 60 + minutes);
  }
  const result = new Date(wall.getTime() - offset(zone));
  if (result.getUTCFullYear() < 1 || result.getUTCFullYear() > 9999) throw new Error("日期超出范围。");
  return result.toISOString();
}

export function importDateInput(iso: string, offsetMinutes = 0) {
  return new Date(new Date(iso).getTime() + offset(offsetMinutes)).toISOString().slice(0, 16);
}
