export const SCRIPT_REWRITE_PROMPT_VERSION = "script-rewrite.v16-spoken-facts-2026-10-10";
export const SCRIPT_REWRITE_MAX_CHARACTERS = 12_000;
export const SCRIPT_REWRITE_MICRO_BATCH_CHARACTERS = 1_800;
export const SCRIPT_REWRITE_MICRO_BATCH_UNITS = 4;
export const SCRIPT_REWRITE_MICRO_REPAIR_ATTEMPTS = 4;

export type ScriptRewriteVariant = "light_rewrite" | "restructured";
export type ScriptUnit = { paragraphId: string; text: string };
export type RewriteParagraph = { paragraphId: string; text: string };
export type RewriteFactCard = {
  factId: string;
  statement: string;
  kind: string;
  sourceParagraphIds: string[];
  immutableFacts: string[];
};
export type RewriteOutlineSection = {
  sectionId: string;
  title: string;
  role: string;
  factIds: string[];
  sourceParagraphIds: string[];
};
export type RewriteValidationCheck = {
  key: string;
  label: string;
  passed: boolean;
  value: string | number;
};
export type RewriteValidation = {
  passed: boolean;
  checks: RewriteValidationCheck[];
  lengthRatio: number;
  textSimilarity: number;
  effectiveChangeCoveragePercent: number;
  changedParagraphPercent: number;
  missingImmutableFacts: string[];
  unexpectedImmutableFacts?: string[];
  sequenceSimilarity?: number;
  longestCopiedSpan?: number;
  copiedParagraphIndexes?: number[];
  copiedSpans?: string[];
  semanticAudit?: {
    passed: boolean;
    missingFactIds: string[];
    addedClaims: string[];
    structureRebuilt: boolean;
    copyRisk: "low" | "medium" | "high";
    notes: string[];
    problemParagraphIds?: string[];
    coreInformationRetention?: number;
    structureAligned?: boolean;
    styleAligned?: boolean;
    conclusionAligned?: boolean;
    purposePreserved?: boolean;
    productionNotesPreserved?: boolean;
    logicCoherent?: boolean;
    riskExpanded?: boolean;
  };
};

const SCRIPT_BOUNDARY = /(?<=[。！？!?；;])/u;
const SCRIPT_NORMALIZATION = /[\s，。！？；：、,.!?;:'"“”‘’（）()\u005B\u005D【】《》〈〉…—-]+/gu;
const IMMUTABLE_FACT = /(?:\d+(?:[.,]\d+)?\s*%?|[A-Za-z][A-Za-z0-9_.:/+-]{1,})/gu;
const BRACKETED_PRODUCTION_TIME = /[【[(]\s*(?:\d{1,2}:\d{2}(?::\d{2})?|\d+(?:[.,]\d+)?\s*(?:(?:[-—~～]|至)\s*\d+(?:[.,]\d+)?)?\s*(?:秒|s|分钟|min))\s*[】)\]]/giu;
const COLON_TIMECODE = /\b\d{1,2}:\d{2}(?::\d{2})?\b/gu;
const RANGE_PRODUCTION_TIME = /\b\d+(?:[.,]\d+)?\s*(?:[-—~～]|至)\s*\d+(?:[.,]\d+)?\s*(?:秒|s|分钟|min)/giu;
const LABELED_PRODUCTION_TIME = /(?:开场|结尾|转折|案例|方法|镜头|画面|口播|段落)\s*(?:[·:：-]\s*)?\d+(?:[.,]\d+)?\s*(?:秒|s|分钟|min)/giu;

export function normalizeRewriteText(value: string) {
  return value.replace(SCRIPT_NORMALIZATION, "").toLocaleLowerCase("zh-CN");
}

export function immutableRewriteFacts(value: string) {
  const facts = new Set<string>();
  const semanticValue = value
    .replace(BRACKETED_PRODUCTION_TIME, " ")
    .replace(COLON_TIMECODE, " ")
    .replace(RANGE_PRODUCTION_TIME, " ")
    .replace(LABELED_PRODUCTION_TIME, " ");
  for (const match of semanticValue.matchAll(IMMUTABLE_FACT)) {
    const item = match[0].replace(/\s+/gu, "").replace(/\.+$/u, "").toLocaleLowerCase("zh-CN");
    if (!item) continue;
    if (/^\d/u.test(item) || /\d|[_.:/+-]/u.test(item) || /[A-Z]/u.test(match[0])) facts.add(item);
  }
  return [...facts].sort();
}

const PROTECTED_FACT_EQUIVALENTS: Record<string, string[]> = {
  ai: ["人工智能"],
  asr: ["自动语音识别", "语音识别"],
  cta: ["行动号召", "行动引导", "转化引导"],
  crm: ["客户关系管理"],
  ocr: ["光学字符识别", "文字识别"],
  sop: ["标准操作流程", "标准作业流程"],
  stylus: ["触控笔", "手写笔"],
};

function protectedFactAppearsOrHasEquivalent(fact: string, value: string) {
  const normalizedValue = normalizeRewriteText(value);
  const normalizedFact = normalizeRewriteText(fact);
  if (normalizedFact && normalizedValue.includes(normalizedFact)) return true;
  return (PROTECTED_FACT_EQUIVALENTS[fact.toLocaleLowerCase("zh-CN")] ?? [])
    .some((equivalent) => normalizedValue.includes(normalizeRewriteText(equivalent)));
}

const CHINESE_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CHINESE_SMALL_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1_000 };

function parseChineseNumber(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  // Large units apply to the entire coefficient, including decimal quantities
  // such as 二点一万 and nested scales such as 一万亿.
  for (const [unit, scale] of [["亿", 100_000_000], ["万", 10_000]] as const) {
    const index = value.indexOf(unit);
    if (index < 0) continue;
    const coefficient = index ? parseChineseNumber(value.slice(0, index)) : 1;
    const remainder = index + 1 < value.length ? parseChineseNumber(value.slice(index + 1)) : 0;
    return coefficient === null || remainder === null ? null : coefficient * scale + remainder;
  }
  if (value.includes("点")) {
    const [integerRaw, decimalRaw = ""] = value.split("点", 2);
    const integer: number = parseChineseNumber(integerRaw) ?? 0;
    const decimalDigits = [...decimalRaw].flatMap((character) => character in CHINESE_DIGITS ? [String(CHINESE_DIGITS[character])] : []);
    return decimalDigits.length ? Number(`${integer}.${decimalDigits.join("")}`) : integer;
  }
  if (![...value].some((character) => character in CHINESE_SMALL_UNITS || character === "万" || character === "亿")) {
    const digits = [...value].flatMap((character) => character in CHINESE_DIGITS ? [String(CHINESE_DIGITS[character])] : []);
    return digits.length ? Number(digits.join("")) : null;
  }
  let total = 0;
  let section = 0;
  let number = 0;
  for (const character of value) {
    if (character in CHINESE_DIGITS) {
      number = CHINESE_DIGITS[character];
      continue;
    }
    if (character in CHINESE_SMALL_UNITS) {
      const unit = CHINESE_SMALL_UNITS[character];
      section += (number || 1) * unit;
      number = 0;
      continue;
    }
    if (character === "万" || character === "亿") {
      const unit = character === "万" ? 10_000 : 100_000_000;
      section = (section + number || 1) * unit;
      total += section;
      section = 0;
      number = 0;
    }
  }
  return total + section + number;
}

function canonicalNumber(value: number) {
  if (!Number.isFinite(value)) return "";
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(8)));
}

export function semanticRewriteFacts(value: string) {
  // Spoken technical identifiers may mix Latin letters and Chinese digits.
  // Canonicalize the identifier as a whole: IP六八 and IP68 are the same rating,
  // while IP67 must still fail. Surface-preserving micro rewrites stay unchanged.
  const spokenValue = value
    // Only discourse markers at a sentence boundary are disposable. A product
    // named OK or a result such as “状态为OK” remains an immutable identifier.
    .replace(/(^|[。！？!?]\s*|(?:好|好的|是的|够了|行)[，,]\s*)ok(?=[，,！!])/giu, "$1")
    // Require an explicit correction followed by the same corrected quantity
    // again. Do not discard an earlier number merely because another follows.
    .replace(/([零〇一二两三四五六七八九十百千万亿]+)(人|名)[。！？]\s*对(?:的)?[，,]\s*([零〇一二两三四五六七八九十百千万亿]+)\2(?:哦|啊)[，,]\s*\3\2/gu, "$3$2")
    // “三四两个池塘” is a pair of labels plus a count, never the number 342.
    .replace(/([一二三四五六七八九])(?:[、，]|和)?([一二三四五六七八九])两(?=个)/gu, (_match, first: string, second: string) => `${CHINESE_DIGITS[first]}、${CHINESE_DIGITS[second]}，两`)
    .replace(/([一二三四五六七八九])(?:[、，]|和)?([一二三四五六七八九])(?=食堂|池塘)/gu, (_match, first: string, second: string) => `${CHINESE_DIGITS[first]}、${CHINESE_DIGITS[second]}`)
    .replace(/一半|半数/gu, "50%")
    .replace(/([零〇一二两三四五六七八九十]+)点([零〇一二两三四五六七八九十]+)(?=开门|关门|收摊)/gu, (match, hourRaw: string, minuteRaw: string) => {
      const hour = parseChineseNumber(hourRaw), minute = parseChineseNumber(minuteRaw);
      return hour !== null && hour <= 24 && minute !== null && minute < 60 ? `${hour}点${minute}分` : match;
    })
    .replace(/(?<![零〇一二两三四五六七八九十百千])([十百千])\1(?=块|元|名|人)/gu, "$1")
    .replace(/([零〇一二两三四五六七八九十百千万亿]+)分之([零〇一二两三四五六七八九十百千万亿]+)/gu, (match, denominatorRaw: string, numeratorRaw: string) => {
      if (denominatorRaw === "百") return match; // The percent-range scanner also reads its upper bound.
      const denominator = parseChineseNumber(denominatorRaw), numerator = parseChineseNumber(numeratorRaw);
      return denominator && numerator !== null ? `${canonicalNumber(numerator / denominator * 100)}%` : match;
    })
    // Preserve both ends of approximate scaled quantities, including stutters
    // such as “五五六百”. Treat 450 (四百五十) as an exact number instead.
    .replace(/([一二三四五六七八九])\1?([一二三四五六七八九])(百|千)(?=(?:多|名|人|个|块|元|左右))/gu, (_match, lower: string, upper: string, scale: string) => `${CHINESE_DIGITS[lower] * CHINESE_SMALL_UNITS[scale]}到${CHINESE_DIGITS[upper] * CHINESE_SMALL_UNITS[scale]}`)
    .replace(/千万(?=(?:不要|别|不能|不可|务必|记得|小心|要))/gu, "")
    .replace(/([零〇一二两三四五六七八九十百千点]+)(?:多|几)(万|亿)/gu, "$1$2")
    .replace(/([零〇一二两三四五六七八九十百千][零〇一二两三四五六七八九十百千万亿点]*[万亿][零〇一二两三四五六七八九十百千万亿点]*)/gu, (match) => {
      const parsed = parseChineseNumber(match);
      return parsed === null ? match : canonicalNumber(parsed);
    })
    .replace(/(\d+(?:[.,]\d+)?)(?:多|几)?(万|亿)/gu, (_match, raw: string, scale: string) => canonicalNumber(Number(raw.replace(",", ".")) * (scale === "万" ? 10_000 : 100_000_000)));
  const identifierValue = spokenValue.replace(/\b(?:team\s+team|tim\s+tim)(?=\s*[,，])/giu, " ").replace(/(\d+(?:[.,]\d+)?|[零〇一二两三四五六七八九十百千万亿点]+)\s*(万|亿)\s*像素/gu, (match, raw: string, scale: string) => {
    const number = /^\d/u.test(raw) ? Number(raw.replace(",", ".")) : parseChineseNumber(raw);
    return number === null ? match : `${canonicalNumber(number * (scale === "万" ? 10_000 : 100_000_000))}像素`;
  }).replace(/\b(IP)\s*([零〇一二两三四五六七八九]{2})(?![零〇一二两三四五六七八九])/giu, (match, prefix: string, raw: string) => {
    const number = parseChineseNumber(raw);
    return number === null ? match : `${prefix}${canonicalNumber(number)}`;
  });
  const facts = new Set(immutableRewriteFacts(identifierValue));
  // An interjection in quoted speech is not a product/person identifier.
  facts.delete("yeah");
  // “千万” is commonly an adverb in spoken Chinese (for example “千万不要”),
  // not the quantity ten million. Remove only those modal uses before scanning
  // Chinese quantities so they cannot invent a protected numeric fact.
  const numericValue = identifierValue.replace(/千万(?=(?:不要|别|不能|不可|务必|记得|小心|要))/gu, "");
  const numeral = "零〇一二两三四五六七八九十百千万亿点";
  // A quoted price/answer can have no classifier: “十六哦，那也很好”.
  // Require a compound numeral, so sentence-final “第一” is not a hard count.
  const bareNumberPattern = new RegExp(`([零〇一二两三四五六七八九]*[十百千][${numeral}]*)(?=(?:哦|啊|呀)?[，。！？!?])`, "gu");
  for (const match of numericValue.matchAll(bareNumberPattern)) {
    const parsed = parseChineseNumber(match[1]);
    if (parsed !== null) facts.add(canonicalNumber(parsed));
  }
  const addPercent = (percentage: number) => {
    const canonical = canonicalNumber(percentage);
    if (!canonical) return;
    // Keep both representations. This lets “5%” compare with the semantically
    // equivalent “每 100 人里有 5 人” without weakening a percent into a plain number.
    facts.add(canonical);
    facts.add(`${canonical}%`);
  };
  const arabicPercentPattern = /(\d+(?:[.,]\d+)?)\s*%/gu;
  for (const match of numericValue.matchAll(arabicPercentPattern)) addPercent(Number(match[1].replace(",", ".")));
  const percentPattern = new RegExp(`百分之([${numeral}]+)(?:(?:到|至|[-—~～])([${numeral}]+))?`, "gu");
  for (const match of numericValue.matchAll(percentPattern)) {
    const parsed = parseChineseNumber(match[1]);
    if (parsed !== null) addPercent(parsed);
    if (match[2]) {
      const upper = parseChineseNumber(match[2]);
      if (upper !== null) addPercent(upper);
    }
  }
  // Common spoken equivalents must remain valid in a spoken-script rewrite.
  if (/(?:百发百中|百分百(?:命中|成功|做到|达成)?|全部命中|每次(?:都)?命中)/u.test(numericValue)) {
    addPercent(100);
  }
  const numberToken = `(?:\\d+(?:[.,]\\d+)?|[${numeral}]+)`;
  const percentRange = new RegExp(`(${numberToken})\\s*%?\\s*(?:到|至|[-—~～])\\s*(${numberToken})\\s*%`, "gu");
  for (const match of numericValue.matchAll(percentRange)) {
    for (const raw of [match[1], match[2]]) {
      const parsed = /^\d/u.test(raw) ? Number(raw.replace(",", ".")) : parseChineseNumber(raw);
      if (parsed !== null) addPercent(parsed);
    }
  }
  const perBaseRatioPattern = new RegExp(
    `每\\s*(${numberToken})\\s*(?:个|人|次|颗)?[^。！？!?；;\\n]{0,100}?(?:只(?:有|剩(?:下)?)|剩(?:下)?|存活(?:的)?(?:只)?有|(?:还)?(?:能)?活着(?:的)?(?:只)?有|成功(?:的)?(?:只)?有|命中(?:的)?(?:只)?有)\\s*(${numberToken})`,
    "gu",
  );
  for (const match of numericValue.matchAll(perBaseRatioPattern)) {
    const readNumber = (raw: string) => /^\d/u.test(raw) ? Number(raw.replace(",", ".")) : parseChineseNumber(raw);
    const denominator = readNumber(match[1]);
    const numerator = readNumber(match[2]);
    if (denominator !== null && numerator !== null && denominator > 0 && numerator >= 0 && numerator <= denominator) {
      addPercent(numerator / denominator * 100);
    }
  }
  const rangePattern = new RegExp(`([${numeral}]+)\\s*(?:充)?(?:到|至|[-—~～])\\s*([${numeral}]+)`, "gu");
  for (const match of numericValue.matchAll(rangePattern)) {
    for (const raw of [match[1], match[2]]) {
      const parsed = parseChineseNumber(raw);
      if (parsed !== null) facts.add(canonicalNumber(parsed));
    }
  }
  // Consume the quantity suffix instead of only looking ahead to it. Otherwise
  // a phrase such as “十几万块” is matched twice: first as “十几(万)” and
  // again as the standalone “万(块)”, inventing an extra protected value 10000.
  const quantifiedPattern = new RegExp(`([${numeral}]+)\\s*(?:多|几)?\\s*(美元|港元|日元|欧元|英镑|美金|尼特|赫兹|PPI|GHz|MHz|Hz|fps|GB|TB|MB|英寸|毫米|厘米|公里|公斤|千克|毫安|像素|分钟|小时|帧|克|米|倍|瓦|年|岁|个|颗|人|名|次|块|元|月|天|号|分|方向|部分|家|秒|成|万|亿)(?!之)`, "giu");
  for (const match of numericValue.matchAll(quantifiedPattern)) {
    const raw = match[1];
    const classifier = match[2];
    if (classifier === "万" || classifier === "亿") {
      const parsed = parseChineseNumber(raw);
      if (parsed !== null) facts.add(canonicalNumber(parsed * (classifier === "万" ? 10_000 : 100_000_000)));
      continue;
    }
    // In spoken copy, “一个” is often an article and “两个角度/说法” is commonly
    // paraphrased as “不同角度/多种说法”. Treat these small 个-counts as semantic
    // details instead of immutable business data. Larger counts such as 二十个,
    // and concrete people/times/money/duration classifiers, remain protected.
    if (classifier === "个" && /^(?:一|二|两)$/u.test(raw)) continue;
    const technicalDigitSequence = /^(?:PPI|GB|TB|MB|GHz|MHz|Hz|fps)$/iu.test(classifier) && !raw.includes("两");
    const adjacentApproximation = !technicalDigitSequence && [...raw].length === 2 && [...raw].every((character) => character in CHINESE_DIGITS);
    if (adjacentApproximation) {
      // “两三个方向”“三四个人”表达的是近似范围，不是 23 或 34。
      for (const character of raw) facts.add(String(CHINESE_DIGITS[character]));
    } else {
      const parsed = parseChineseNumber(raw);
      if (parsed !== null) facts.add(canonicalNumber(parsed));
    }
  }
  return [...facts].filter(Boolean).sort();
}

function splitLongBlock(block: string, targetCharacters: number) {
  if (block.length <= targetCharacters) return [block];
  const sentences = block.split(SCRIPT_BOUNDARY).map((item) => item.trim()).filter(Boolean);
  if (sentences.length <= 1) {
    const chunks: string[] = [];
    for (let index = 0; index < block.length; index += targetCharacters) chunks.push(block.slice(index, index + targetCharacters));
    return chunks;
  }
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > targetCharacters) {
      chunks.push(current);
      current = "";
    }
    current += sentence;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function buildScriptUnits(value: string, targetCharacters = 800): ScriptUnit[] {
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return [];
  const blocks = normalized.split(/\n\s*\n+/gu).map((item) => item.replace(/\s*\n\s*/gu, " ").trim()).filter(Boolean);
  const paragraphs = blocks.flatMap((block) => splitLongBlock(block, targetCharacters));
  return paragraphs.map((text, index) => ({ paragraphId: `p-${String(index + 1).padStart(4, "0")}`, text }));
}

export function batchScriptUnits(units: ScriptUnit[], maximumCharacters = 3_200, maximumUnits = 8) {
  const batches: ScriptUnit[][] = [];
  let current: ScriptUnit[] = [];
  let characters = 0;
  for (const unit of units) {
    if (current.length && (characters + unit.text.length > maximumCharacters || current.length >= maximumUnits)) {
      batches.push(current);
      current = [];
      characters = 0;
    }
    current.push(unit);
    characters += unit.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Split oversized paragraphs internally while keeping their public IDs. */
export function buildMicroRewritePlan(units: ScriptUnit[]) {
  const workingUnits: ScriptUnit[] = [];
  const paragraphParts = units.map((unit) => {
    if (unit.text.length <= SCRIPT_REWRITE_MICRO_BATCH_CHARACTERS) {
      workingUnits.push(unit);
      return { paragraphId: unit.paragraphId, partIds: [unit.paragraphId] };
    }
    const partIds: string[] = [];
    let start = 0;
    while (start < unit.text.length) {
      let end = Math.min(unit.text.length, start + 800);
      if (end < unit.text.length) {
        // Prefer a clause boundary and never bisect a Latin identifier/number.
        const window = unit.text.slice(start + 400, end);
        const boundaries = [...window.matchAll(/[。！？!?；;，,、\n]/gu)];
        if (boundaries.length) end = start + 400 + boundaries.at(-1)!.index! + 1;
        else while (end < unit.text.length && /[A-Za-z0-9零〇一二两三四五六七八九十百千万亿点_.:/%+-]/u.test(unit.text[end - 1])
          && /[A-Za-z0-9零〇一二两三四五六七八九十百千万亿点_.:/%+-]/u.test(unit.text[end])) end += 1;
      }
      const paragraphId = `${unit.paragraphId}-part-${partIds.length + 1}`;
      partIds.push(paragraphId);
      workingUnits.push({ paragraphId, text: unit.text.slice(start, end) });
      start = end;
    }
    return { paragraphId: unit.paragraphId, partIds };
  });
  return { workingUnits, paragraphParts };
}

export function mergeMicroRewriteParts(plan: ReturnType<typeof buildMicroRewritePlan>, rows: RewriteParagraph[]) {
  const byId = new Map(rows.map((row) => [row.paragraphId, row.text]));
  const expected = plan.workingUnits.map((unit) => unit.paragraphId);
  if (rows.length !== expected.length || rows.some((row, index) => row.paragraphId !== expected[index])) return [];
  return plan.paragraphParts.map((paragraph) => ({ paragraphId: paragraph.paragraphId, text: paragraph.partIds.map((id) => byId.get(id)!).join(" ").trim() }));
}

export function partitionScriptRewriteFailures<T extends { variant: string; status: string; sourceVersionId: string; createdAt: string; validation?: { passed?: boolean } }>(runs: T[]) {
  const failed = runs.filter((run) => run.status === "failed");
  const succeeded = runs.filter((run) => run.status === "completed" && run.validation?.passed === true);
  const historical = failed.filter((run) => succeeded.some((success) => success.variant === run.variant
    && success.sourceVersionId === run.sourceVersionId && success.createdAt > run.createdAt));
  return { unresolved: failed.filter((run) => !historical.includes(run)), historical };
}

export function rewriteParagraphTargets(units: ScriptUnit[], minimumRatio = 0.9, maximumRatio = 1.1) {
  return units.map((unit) => {
    const sourceCharacters = normalizeRewriteText(unit.text).length;
    return {
      paragraphId: unit.paragraphId,
      sourceCharacters,
      minimumCharacters: Math.ceil(sourceCharacters * minimumRatio),
      maximumCharacters: Math.max(1, Math.floor(sourceCharacters * maximumRatio)),
    };
  });
}

export function mergeRewriteParagraphRows(units: ScriptUnit[], baseRows: RewriteParagraph[], replacementRows: RewriteParagraph[]) {
  const rowsById = new Map(baseRows.map((row) => [row.paragraphId, row]));
  for (const row of replacementRows) rowsById.set(row.paragraphId, row);
  return units.flatMap((unit) => {
    const row = rowsById.get(unit.paragraphId);
    return row ? [{ paragraphId: unit.paragraphId, text: row.text }] : [];
  });
}

function ngramCounts(value: string, width = 1) {
  const counts = new Map<string, number>();
  if (!value) return counts;
  if (value.length < width) {
    counts.set(value, 1);
    return counts;
  }
  for (let index = 0; index <= value.length - width; index += 1) {
    const gram = value.slice(index, index + width);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

export function rewriteTextSimilarity(source: string, candidate: string) {
  const left = normalizeRewriteText(source);
  const right = normalizeRewriteText(candidate);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftCounts = ngramCounts(left);
  const rightCounts = ngramCounts(right);
  let leftTotal = 0;
  let rightTotal = 0;
  let intersection = 0;
  for (const count of leftCounts.values()) leftTotal += count;
  for (const count of rightCounts.values()) rightTotal += count;
  for (const [gram, count] of leftCounts) intersection += Math.min(count, rightCounts.get(gram) ?? 0);
  return (2 * intersection) / Math.max(1, leftTotal + rightTotal);
}

export function rewriteSequenceSimilarity(source: string, candidate: string) {
  const left = normalizeRewriteText(source);
  const right = normalizeRewriteText(candidate);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const width = Math.min(3, left.length, right.length);
  const leftCounts = ngramCounts(left, width);
  const rightCounts = ngramCounts(right, width);
  let leftTotal = 0;
  let rightTotal = 0;
  let intersection = 0;
  for (const count of leftCounts.values()) leftTotal += count;
  for (const count of rightCounts.values()) rightTotal += count;
  for (const [gram, count] of leftCounts) intersection += Math.min(count, rightCounts.get(gram) ?? 0);
  return (2 * intersection) / Math.max(1, leftTotal + rightTotal);
}

export function longestSharedRewriteSpan(source: string, candidate: string) {
  const haystack = normalizeRewriteText(source);
  const needle = normalizeRewriteText(candidate);
  if (!haystack || !needle) return 0;
  let low = 1;
  let high = Math.min(haystack.length, needle.length);
  let longest = 0;
  while (low <= high) {
    const width = Math.floor((low + high) / 2);
    let found = false;
    for (let index = 0; index <= needle.length - width; index += 1) {
      if (haystack.includes(needle.slice(index, index + width))) { found = true; break; }
    }
    if (found) { longest = width; low = width + 1; } else high = width - 1;
  }
  return longest;
}

export function longestSharedRewriteMatch(source: string, candidate: string) {
  const haystack = normalizeRewriteText(source);
  const needle = normalizeRewriteText(candidate);
  const length = longestSharedRewriteSpan(haystack, needle);
  if (!length) return { length: 0, text: "" };
  for (let index = 0; index <= needle.length - length; index += 1) {
    const text = needle.slice(index, index + length);
    if (haystack.includes(text)) return { length, text };
  }
  return { length, text: "" };
}

function withoutProtectedFacts(value: string, protectedFacts: string[]) {
  let normalized = normalizeRewriteText(value);
  for (const fact of protectedFacts) {
    const protectedValue = normalizeRewriteText(fact);
    if (protectedValue) normalized = normalized.replaceAll(protectedValue, "");
  }
  return normalized;
}

export function validateFactCardAbstraction(units: ScriptUnit[], facts: RewriteFactCard[]) {
  const sourceById = new Map(units.map((item) => [item.paragraphId, item.text]));
  const leakingFactIds: string[] = [];
  let longestCopiedSpan = 0;
  for (const fact of facts) {
    const statement = withoutProtectedFacts(fact.statement, fact.immutableFacts);
    const source = withoutProtectedFacts(fact.sourceParagraphIds.map((id) => sourceById.get(id) ?? "").join("\n"), fact.immutableFacts);
    const copiedSpan = longestSharedRewriteSpan(source, statement);
    longestCopiedSpan = Math.max(longestCopiedSpan, copiedSpan);
    const copiedRatio = copiedSpan / Math.max(1, statement.length);
    // A fact ledger is a faithful semantic inventory, not the finished rewrite. Short
    // domain phrases such as “最耗人力的三个重复环节” often cannot be shortened or
    // paraphrased further without changing the fact itself. Only block substantial
    // sentence-level copying here; final prose still has stricter local-copy checks.
    const copiedWholeLongSentence = copiedSpan >= 28;
    const copiedNearlyAllOfLongStatement = statement.length >= 24 && copiedSpan >= 20 && copiedRatio >= 0.9;
    if (copiedWholeLongSentence || copiedNearlyAllOfLongStatement) leakingFactIds.push(fact.factId);
  }
  return {
    passed: leakingFactIds.length === 0,
    leakingFactIds,
    longestCopiedSpan,
    checks: [{
      key: "semantic_abstraction",
      label: "命题卡片未整句复制原稿",
      passed: leakingFactIds.length === 0,
      value: leakingFactIds.length ? `${leakingFactIds.length} 条存在整句级复制，最长 ${longestCopiedSpan} 字` : "通过",
    }] satisfies RewriteValidationCheck[],
  };
}

export function inspectLocalRewriteCopy(units: ScriptUnit[], paragraphs: string[]) {
  const copiedParagraphIndexes: number[] = [];
  const copiedSpans: string[] = [];
  let longestCopiedSpan = 0;
  let maximumParagraphSimilarity = 0;
  const sentenceFragments = (value: string) => {
    const fragments = value.split(/[。！？!?；;\n]+/u).map((item) => item.trim()).filter(Boolean);
    return fragments.length ? fragments : [value];
  };
  paragraphs.forEach((paragraph, index) => {
    let paragraphLongest = 0;
    let paragraphLongestText = "";
    let paragraphSimilarity = 0;
    for (const unit of units) {
      const protectedFacts = immutableRewriteFacts(unit.text);
      const comparableSource = withoutProtectedFacts(unit.text, protectedFacts);
      const comparableParagraph = withoutProtectedFacts(paragraph, protectedFacts);
      // Keep sentence boundaries while looking for copied spans. Normalizing an
      // entire paragraph removes punctuation and can glue the end of one source
      // sentence to the start of the next, creating a span that never existed.
      for (const sourceFragment of sentenceFragments(unit.text)) {
        const fragmentFacts = immutableRewriteFacts(sourceFragment);
        const comparableSourceFragment = withoutProtectedFacts(sourceFragment, fragmentFacts);
        for (const candidateFragment of sentenceFragments(paragraph)) {
          const comparableCandidateFragment = withoutProtectedFacts(candidateFragment, fragmentFacts);
          const match = longestSharedRewriteMatch(comparableSourceFragment, comparableCandidateFragment);
          if (match.length > paragraphLongest) {
            paragraphLongest = match.length;
            paragraphLongestText = match.text;
          }
        }
      }
      paragraphSimilarity = Math.max(paragraphSimilarity, rewriteSequenceSimilarity(comparableSource, comparableParagraph));
    }
    longestCopiedSpan = Math.max(longestCopiedSpan, paragraphLongest);
    maximumParagraphSimilarity = Math.max(maximumParagraphSimilarity, paragraphSimilarity);
    const paragraphLength = withoutProtectedFacts(paragraph, immutableRewriteFacts(paragraph)).length;
    if (paragraphLongest >= 21 || (paragraphLength >= 36 && paragraphSimilarity >= 0.88)) {
      copiedParagraphIndexes.push(index);
      if (paragraphLongestText) copiedSpans.push(paragraphLongestText);
    }
  });
  return {
    passed: copiedParagraphIndexes.length === 0,
    copiedParagraphIndexes,
    copiedSpans,
    longestCopiedSpan,
    maximumParagraphSimilarity: Number(maximumParagraphSimilarity.toFixed(4)),
  };
}

function check(checks: RewriteValidationCheck[], key: string, label: string, passed: boolean, value: string | number) {
  checks.push({ key, label, passed, value });
}

function baseValidation(units: ScriptUnit[], paragraphs: string[], factMode: "surface" | "semantic" = "surface") {
  const sourceText = units.map((item) => item.text).join("\n\n");
  const candidateText = paragraphs.join("\n\n");
  const sourceNormalized = normalizeRewriteText(sourceText);
  const candidateNormalized = normalizeRewriteText(candidateText);
  const similarity = rewriteTextSimilarity(sourceText, candidateText);
  const sequenceSimilarity = rewriteSequenceSimilarity(sourceText, candidateText);
  const lengthRatio = candidateNormalized.length / Math.max(1, sourceNormalized.length);
  const factReader = factMode === "semantic" ? semanticRewriteFacts : immutableRewriteFacts;
  const sourceFacts = new Set(factReader(sourceText));
  const candidateFacts = new Set(factReader(candidateText));
  const missingFacts = [...sourceFacts].filter((item) => !candidateFacts.has(item) && !protectedFactAppearsOrHasEquivalent(item, candidateText));
  const unexpectedFacts = [...candidateFacts].filter((item) => !sourceFacts.has(item) && !protectedFactAppearsOrHasEquivalent(item, sourceText));
  return { sourceText, candidateText, sourceNormalized, candidateNormalized, similarity, sequenceSimilarity, lengthRatio, missingFacts, unexpectedFacts };
}

export function validateLightRewrite(units: ScriptUnit[], rows: RewriteParagraph[]): RewriteValidation {
  const expectedIds = units.map((item) => item.paragraphId);
  const receivedIds = rows.map((item) => item.paragraphId);
  const paragraphs = rows.map((item) => item.text.trim()).filter(Boolean);
  const base = baseValidation(units, paragraphs);
  const changedParagraphs = units.filter((unit, index) => normalizeRewriteText(unit.text) !== normalizeRewriteText(rows[index]?.text ?? "")).length;
  const changedParagraphPercent = Math.round(changedParagraphs / Math.max(1, units.length) * 100);
  const effectiveChangeCoveragePercent = Math.round((1 - base.sequenceSimilarity) * 1000) / 10;
  const minimumChange = base.sourceNormalized.length < 80 ? 8 : 18;
  const minimumLengthRatio = 0.9;
  const maximumLengthRatio = 1.1;
  const paragraphLengthFailures = units.flatMap((unit, index) => {
    const sourceLength = normalizeRewriteText(unit.text).length;
    const candidateLength = normalizeRewriteText(rows[index]?.text ?? "").length;
    const minimum = sourceLength < 80 ? Math.max(1, sourceLength - 8) : Math.ceil(sourceLength * minimumLengthRatio);
    const maximum = sourceLength < 80 ? sourceLength + 8 : Math.max(1, Math.floor(sourceLength * maximumLengthRatio));
    return candidateLength >= minimum && candidateLength <= maximum
      ? []
      : [{ paragraphId: unit.paragraphId, sourceLength, candidateLength, minimum, maximum }];
  });
  const localCopy = inspectLocalRewriteCopy(units, paragraphs);
  const checks: RewriteValidationCheck[] = [];
  check(checks, "content", "稿件非空", paragraphs.length > 0 && Boolean(base.candidateNormalized), base.candidateNormalized.length);
  check(checks, "mapping", "段落 ID 完整且顺序一致", receivedIds.length === expectedIds.length && receivedIds.every((id, index) => id === expectedIds[index]), `${receivedIds.length}/${expectedIds.length}`);
  check(checks, "paragraphs", "段落数量一致", paragraphs.length === units.length, `${paragraphs.length}/${units.length}`);
  check(checks, "facts", "数字与专有标识完整", base.missingFacts.length === 0, base.missingFacts.length);
  check(checks, "no_new_facts", "未新增数字或专有标识", base.unexpectedFacts.length === 0, base.unexpectedFacts.length);
  check(checks, "length", "篇幅为原稿的 90%—110%", base.lengthRatio >= minimumLengthRatio && base.lengthRatio <= maximumLengthRatio, Number(base.lengthRatio.toFixed(3)));
  check(checks, "paragraph_lengths", "长段落分别保持原段篇幅", paragraphLengthFailures.length === 0, paragraphLengthFailures.length ? paragraphLengthFailures.map((item) => `${item.paragraphId}:${item.candidateLength}/${item.minimum}-${item.maximum}`).join("，") : "全部达标");
  check(checks, "effective_change", "表达重写达到微调同构强度", effectiveChangeCoveragePercent >= minimumChange, `${effectiveChangeCoveragePercent}% / ≥${minimumChange}%`);
  check(checks, "changed_paragraphs", "全部对应段落均已改写", changedParagraphPercent === 100, `${changedParagraphPercent}%`);
  check(checks, "local_copy", "不存在整句或整段照搬", localCopy.passed, localCopy.passed ? "未发现" : `${localCopy.copiedParagraphIndexes.length} 段，最长连续 ${localCopy.longestCopiedSpan} 字`);
  return {
    passed: checks.every((item) => item.passed), checks,
    lengthRatio: Number(base.lengthRatio.toFixed(4)),
    textSimilarity: Number(base.similarity.toFixed(4)),
    effectiveChangeCoveragePercent,
    changedParagraphPercent,
    missingImmutableFacts: base.missingFacts,
    unexpectedImmutableFacts: base.unexpectedFacts,
    sequenceSimilarity: Number(base.sequenceSimilarity.toFixed(4)),
    longestCopiedSpan: localCopy.longestCopiedSpan,
    copiedParagraphIndexes: localCopy.copiedParagraphIndexes,
    copiedSpans: localCopy.copiedSpans,
  };
}

export function isReviewableLightRewrite(validation: RewriteValidation) {
  const passed = (key: string) => validation.checks.find((item) => item.key === key)?.passed === true;
  const required = ["content", "mapping", "paragraphs", "facts", "no_new_facts", "changed_paragraphs"];
  return required.every(passed)
    && validation.lengthRatio >= 0.8 && validation.lengthRatio <= 1.25
    && validation.effectiveChangeCoveragePercent >= 8
    // A short residual phrase is a review warning, not a reason to discard an
    // otherwise complete draft. Obvious long-form copying remains a hard stop.
    && (validation.longestCopiedSpan ?? 0) < 48
    && (validation.sequenceSimilarity ?? 1) < 0.82;
}

/** Select replacements independently so a repair cannot undo a good paragraph. */
export function mergeImprovedRewriteParagraphRows(units: ScriptUnit[], rows: RewriteParagraph[], replacements: RewriteParagraph[]) {
  const knownIds = new Set(units.map((unit) => unit.paragraphId));
  if (new Set(replacements.map((row) => row.paragraphId)).size !== replacements.length
    || replacements.some((row) => !knownIds.has(row.paragraphId))) return rows;
  const accepted = replacements.filter((replacement) => {
    const unit = units.find((item) => item.paragraphId === replacement.paragraphId)!;
    const previous = rows.find((item) => item.paragraphId === replacement.paragraphId);
    const nextValidation = validateLightRewrite([unit], [replacement]);
    const previousValidation = validateLightRewrite([unit], previous ? [previous] : []);
    return nextValidation.passed || rewriteValidationQualityScore(nextValidation) > rewriteValidationQualityScore(previousValidation);
  });
  return mergeRewriteParagraphRows(units, rows, accepted);
}

export type RewriteCopyRepairWindow = { paragraphId: string; targetId: string; start: number; end: number; text: string };

/** Keep offsets in the actual draft; normalized copied spans omit protected terms. */
export function buildRewriteCopyRepairWindows(units: ScriptUnit[], rows: RewriteParagraph[]): RewriteCopyRepairWindow[] {
  const windows: RewriteCopyRepairWindow[] = [];
  for (const row of rows) {
    if (inspectLocalRewriteCopy(units, [row.text]).passed) continue;
    const fragments = [...row.text.matchAll(/[^。！？!?；;\n]+[。！？!?；;\n]*/gu)].map((match) => ({ text: match[0], start: match.index }));
    let rejected = fragments.filter((fragment) => !inspectLocalRewriteCopy(units, [fragment.text]).passed);
    if (!rejected.length) rejected = [{ text: row.text, start: 0 }];
    rejected.forEach((fragment, index) => windows.push({
      paragraphId: row.paragraphId, targetId: `${row.paragraphId}-copy-${index + 1}`,
      start: fragment.start, end: fragment.start + fragment.text.length, text: fragment.text,
    }));
  }
  return windows;
}

export function applyRewriteCopyRepairs(rows: RewriteParagraph[], windows: RewriteCopyRepairWindow[], replacements: RewriteParagraph[]) {
  const allowed = new Set(windows.map((window) => window.targetId));
  if (new Set(replacements.map((row) => row.paragraphId)).size !== replacements.length
    || replacements.some((row) => !allowed.has(row.paragraphId))) return rows;
  const byId = new Map(replacements.map((row) => [row.paragraphId, row.text]));
  return rows.map((row) => {
    let text = row.text;
    for (const window of windows.filter((item) => item.paragraphId === row.paragraphId).sort((a, b) => b.start - a.start)) {
      const replacement = byId.get(window.targetId);
      if (replacement?.trim() && text.slice(window.start, window.end) === window.text) {
        text = text.slice(0, window.start) + replacement.trim() + text.slice(window.end);
      }
    }
    return { ...row, text };
  });
}

/** Include connected source paragraphs before replacing a multi-source fact. */
export function buildRewriteFactRepairScope(units: ScriptUnit[], facts: RewriteFactCard[]) {
  const validation = validateRewriteFactCards(units, facts);
  const failed = validation.checks.filter((item) => !item.passed).map((item) => item.key);
  const covered = new Set(facts.flatMap((fact) => fact.sourceParagraphIds));
  const known = new Set(units.map((unit) => unit.paragraphId));
  const fullRepair = failed.some((key) => !["fact_immutables", "source_coverage"].includes(key))
    || facts.some((fact) => fact.sourceParagraphIds.some((id) => !known.has(id)));
  const targetIds = new Set(units.filter((unit) => fullRepair || !covered.has(unit.paragraphId)
    || semanticRewriteFacts(unit.text).some((fact) => validation.missingImmutableFacts.includes(fact))).map((unit) => unit.paragraphId));
  let previousSize = -1;
  while (previousSize !== targetIds.size) {
    previousSize = targetIds.size;
    for (const fact of facts) {
      if (fact.sourceParagraphIds.some((id) => targetIds.has(id))) {
        fact.sourceParagraphIds.filter((id) => known.has(id)).forEach((id) => targetIds.add(id));
      }
    }
  }
  const targetFacts = facts.filter((fact) => fullRepair || fact.sourceParagraphIds.some((id) => targetIds.has(id)));
  const retainedFacts = facts.filter((fact) => !targetFacts.includes(fact));
  return { units: units.filter((unit) => targetIds.has(unit.paragraphId)), targetFacts, retainedFacts };
}

/** Locate original sentences for a small additive repair; never synthesize facts. */
export function buildMissingRewriteFactSources(units: ScriptUnit[], missing: string[]) {
  const required = new Set(missing);
  return units.flatMap((unit) => {
    const sentences = unit.text.split(SCRIPT_BOUNDARY).filter((sentence) => semanticRewriteFacts(sentence).some((fact) => required.has(fact)));
    return sentences.length ? [{ paragraphId: unit.paragraphId, text: sentences.join("") }] : [];
  });
}

export function validateRewriteFactCards(units: ScriptUnit[], facts: RewriteFactCard[]) {
  const expectedParagraphIds = new Set(units.map((item) => item.paragraphId));
  const factIds = facts.map((item) => item.factId);
  const uniqueFactIds = new Set(factIds);
  const coveredParagraphIds = new Set(facts.flatMap((item) => item.sourceParagraphIds));
  const knownSources = facts.every((item) => item.sourceParagraphIds.length > 0 && item.sourceParagraphIds.every((id) => expectedParagraphIds.has(id)));
  const completeSources = [...expectedParagraphIds].every((id) => coveredParagraphIds.has(id));
  const described = facts.length > 0 && facts.every((item) => item.factId && item.statement && item.kind);
  const unique = factIds.length === uniqueFactIds.size;
  const sourceText = units.map((item) => item.text).join("\n\n");
  const ledgerText = facts.flatMap((item) => [item.statement, ...item.immutableFacts]).join("\n");
  // Explicit immutable metadata is already classified by the extractor. It may
  // use lowercase spellings ("team", "iphone") which the prose scanner rightly
  // ignores as ordinary English. Do not lose these declared identifiers here.
  const declaredImmutableFacts = facts.flatMap((fact) => fact.immutableFacts.flatMap((value) => {
    const extracted = semanticRewriteFacts(value);
    return extracted.length ? extracted : /^[A-Za-z][A-Za-z0-9_.:/+-]*$/u.test(value.trim()) ? [value.trim().toLocaleLowerCase("zh-CN")] : [];
  }));
  const ledgerImmutableFacts = new Set([...semanticRewriteFacts(ledgerText), ...declaredImmutableFacts]);
  const missingImmutableFacts = semanticRewriteFacts(sourceText).filter((item) => !ledgerImmutableFacts.has(item));
  const sourceDetailCharacters = normalizeRewriteText(sourceText).length;
  const ledgerDetailCharacters = normalizeRewriteText(facts.map((item) => item.statement).join("\n")).length;
  const detailRatio = ledgerDetailCharacters / Math.max(1, sourceDetailCharacters);
  const targetDetailRatio = sourceDetailCharacters >= 1_000 ? 0.45 : 0.3;
  // A semantic ledger is intentionally denser than the source prose. Keep a
  // hard floor that still rejects conclusion-only summaries, while treating
  // the fuller target as a quality signal rather than aborting a usable run.
  const minimumDetailRatio = sourceDetailCharacters >= 1_000 ? 0.35 : 0.25;
  const abstraction = validateFactCardAbstraction(units, facts);
  const checks: RewriteValidationCheck[] = [];
  check(checks, "fact_cards", "命题清单有效且 ID 唯一", described && unique, String(uniqueFactIds.size) + "/" + String(facts.length));
  check(checks, "source_coverage", "命题覆盖全部来源段落", knownSources && completeSources, String(coveredParagraphIds.size) + "/" + String(expectedParagraphIds.size));
  check(checks, "fact_immutables", "命题清单保留数字与专有标识", missingImmutableFacts.length === 0, missingImmutableFacts.length);
  check(checks, "fact_detail_coverage", "命题账本达到完整性硬底线", detailRatio >= minimumDetailRatio, `${Math.round(detailRatio * 1000) / 10}% / ≥${minimumDetailRatio * 100}%`);
  const warnings = [
    ...abstraction.checks,
    {
      key: "fact_detail_target",
      label: "命题账本达到建议细节量",
      passed: detailRatio >= targetDetailRatio,
      value: `${Math.round(detailRatio * 1000) / 10}% / 建议≥${targetDetailRatio * 100}%`,
    } satisfies RewriteValidationCheck,
  ];
  return {
    passed: checks.every((item) => item.passed),
    checks,
    warnings,
    missingImmutableFacts,
    leakingFactIds: abstraction.leakingFactIds,
    longestCopiedSpan: abstraction.longestCopiedSpan,
    detailRatio: Number(detailRatio.toFixed(4)),
  };
}

export function repairRestructureOutline(facts: RewriteFactCard[], outline: RewriteOutlineSection[]) {
  const factById = new Map(facts.map((item) => [item.factId, item]));
  const seen = new Set<string>();
  const repaired = outline.map((section) => {
    const factIds = section.factIds.filter((id) => factById.has(id) && !seen.has(id));
    factIds.forEach((id) => seen.add(id));
    return { ...section, factIds };
  }).filter((section) => section.factIds.length > 0);
  if (!repaired.length) return outline;
  for (const fact of facts) {
    if (seen.has(fact.factId)) continue;
    let bestIndex = 0;
    let bestScore = -1;
    repaired.forEach((section, index) => {
      const sectionSources = new Set(section.factIds.flatMap((id) => factById.get(id)?.sourceParagraphIds ?? []));
      const sourceScore = fact.sourceParagraphIds.filter((id) => sectionSources.has(id)).length * 10;
      const role = section.role.toLocaleLowerCase("zh-CN");
      const roleScore = fact.kind === "conclusion" && role.includes("conclusion") ? 3
        : fact.kind === "example" && role.includes("example") ? 2
          : fact.kind === "reason" && (role.includes("mechanism") || role.includes("reframe")) ? 2
            : 0;
      const score = sourceScore + roleScore;
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    });
    repaired[bestIndex] = { ...repaired[bestIndex], factIds: [...repaired[bestIndex].factIds, fact.factId] };
    seen.add(fact.factId);
  }
  return repaired.map((section) => ({
    ...section,
    sourceParagraphIds: [...new Set(section.factIds.flatMap((id) => factById.get(id)?.sourceParagraphIds ?? []))],
  }));
}

export function fallbackRestructureOutline(facts: RewriteFactCard[], maximumSections = 7): RewriteOutlineSection[] {
  if (!facts.length) return [];
  const pivot = facts.length > 1 ? Math.ceil(facts.length / 2) : 0;
  const reordered = pivot ? [...facts.slice(pivot), ...facts.slice(0, pivot)] : facts;
  const sectionCount = Math.max(1, Math.min(maximumSections, Math.ceil(reordered.length / 4)));
  const size = Math.ceil(reordered.length / sectionCount);
  const roleByKind: Record<string, string> = {
    conclusion: "conclusion_first",
    example: "example",
    reason: "mechanism",
    method: "action",
    action: "action",
    problem: "problem",
  };
  const sections: RewriteOutlineSection[] = [];
  for (let index = 0; index < reordered.length; index += size) {
    const group = reordered.slice(index, index + size);
    sections.push({
      sectionId: `s-${String(sections.length + 1).padStart(2, "0")}`,
      title: sections.length === 0 ? "换一个角度切入" : `重构推进 ${sections.length + 1}`,
      role: sections.length === 0 ? "hook" : roleByKind[group[0]?.kind] ?? "independent_section",
      factIds: group.map((item) => item.factId),
      sourceParagraphIds: [...new Set(group.flatMap((item) => item.sourceParagraphIds))],
    });
  }
  return sections;
}

export function compactRestructureOutline(facts: RewriteFactCard[], outline: RewriteOutlineSection[], maximumSections = 8) {
  const maximum = Math.max(1, Math.floor(maximumSections));
  if (outline.length <= maximum) return outline;
  const factById = new Map(facts.map((item) => [item.factId, item]));
  const groups: RewriteOutlineSection[][] = [];
  let current: RewriteOutlineSection[] = [];
  let currentFacts = 0;
  let remainingFacts = outline.reduce((sum, item) => sum + item.factIds.length, 0);
  for (let index = 0; index < outline.length; index += 1) {
    const section = outline[index];
    current.push(section);
    currentFacts += section.factIds.length;
    remainingFacts -= section.factIds.length;
    const remainingGroups = maximum - groups.length - 1;
    const target = Math.ceil((currentFacts + remainingFacts) / Math.max(1, remainingGroups + 1));
    const remainingSections = outline.length - index - 1;
    if (groups.length < maximum - 1 && currentFacts >= target && remainingSections >= remainingGroups) {
      groups.push(current);
      current = [];
      currentFacts = 0;
    }
  }
  if (current.length) groups.push(current);
  return groups.map((group, index) => {
    const factIds = group.flatMap((item) => item.factIds);
    const titles = [...new Set(group.map((item) => item.title).filter(Boolean))];
    const roles = [...new Set(group.map((item) => item.role).filter(Boolean))];
    return {
      sectionId: `s-${String(index + 1).padStart(2, "0")}`,
      title: titles.join(" / ").slice(0, 160) || `重构段落 ${index + 1}`,
      role: roles.join(" → ").slice(0, 300) || "independent_section",
      factIds,
      sourceParagraphIds: [...new Set(factIds.flatMap((id) => factById.get(id)?.sourceParagraphIds ?? []))],
    };
  });
}

export function buildRestructureLengthTargets(sourceText: string, facts: RewriteFactCard[], outline: RewriteOutlineSection[]) {
  const sourceCharacters = normalizeRewriteText(sourceText).length;
  const targetCharacters = Math.max(1, Math.round(sourceCharacters * 0.95));
  const factById = new Map(facts.map((fact) => [fact.factId, fact]));
  const weights = outline.map((section) => Math.max(1, section.factIds.reduce((sum, factId) => sum + normalizeRewriteText(factById.get(factId)?.statement ?? "").length, 0)));
  const weightTotal = Math.max(1, weights.reduce((sum, value) => sum + value, 0));
  const baseCharacters = outline.length ? Math.min(50, Math.max(10, Math.floor(targetCharacters / Math.max(1, outline.length * 3)))) : 0;
  const distributable = Math.max(0, targetCharacters - baseCharacters * outline.length);
  const sectionTargets = outline.map((section, index) => {
    const target = baseCharacters + Math.round(distributable * weights[index] / weightTotal);
    return {
      sectionId: section.sectionId,
      targetCharacters: Math.max(1, target),
      minimumCharacters: Math.max(1, Math.floor(target * 0.9)),
      maximumCharacters: Math.max(1, Math.ceil(target * 1.1)),
    };
  });
  if (sectionTargets.length) {
    const assigned = sectionTargets.reduce((sum, item) => sum + item.targetCharacters, 0);
    const last = sectionTargets[sectionTargets.length - 1];
    last.targetCharacters = Math.max(1, last.targetCharacters + targetCharacters - assigned);
    last.minimumCharacters = Math.max(1, Math.floor(last.targetCharacters * 0.9));
    last.maximumCharacters = Math.max(1, Math.ceil(last.targetCharacters * 1.1));
  }
  return {
    sourceCharacters,
    targetCharacters,
    minimumCharacters: Math.max(1, Math.ceil(sourceCharacters * 0.5)),
    maximumCharacters: Math.max(1, Math.floor(sourceCharacters * 1.25)),
    sections: sectionTargets,
  };
}

export function validateRestructurePlan(units: ScriptUnit[], facts: RewriteFactCard[], outline: RewriteOutlineSection[]) {
  const expectedFactIds = facts.map((item) => item.factId);
  const plannedFactIds = outline.flatMap((item) => item.factIds);
  const uniqueFactIds = new Set(plannedFactIds);
  const complete = plannedFactIds.length === expectedFactIds.length && uniqueFactIds.size === expectedFactIds.length && expectedFactIds.every((id) => uniqueFactIds.has(id));
  const knownSources = new Set(units.map((item) => item.paragraphId));
  const described = outline.length > 0 && outline.every((item) => item.sectionId && item.title && item.role && item.factIds.length > 0 && item.sourceParagraphIds.every((id) => knownSources.has(id)));
  const sourceOrder = expectedFactIds.join("|");
  const plannedOrder = plannedFactIds.join("|");
  const firstChanged = expectedFactIds.length > 1 && plannedFactIds[0] !== expectedFactIds[0];
  const changedPositions = plannedFactIds.filter((id, index) => id !== expectedFactIds[index]).length;
  const orderChangeRatio = changedPositions / Math.max(1, expectedFactIds.length);
  const reordered = sourceOrder !== plannedOrder && orderChangeRatio >= (expectedFactIds.length < 4 ? 0.5 : 0.34);
  const regrouped = outline.length < expectedFactIds.length && outline.some((item) => item.factIds.length > 1);
  const rebuildSignals = [firstChanged, reordered, regrouped].filter(Boolean).length;
  // Merely putting the original fact order into fewer boxes is still the same
  // narrative. A real equivalent reconstruction must change the information
  // order (and may additionally regroup facts into new sections).
  const rebuilt = expectedFactIds.length <= 1 || firstChanged || reordered;
  return {
    passed: complete && described && rebuilt,
    checks: [
      { key: "coverage", label: "新提纲完整且唯一覆盖命题", passed: complete, value: String(uniqueFactIds.size) + "/" + String(expectedFactIds.length) },
      { key: "outline", label: "新提纲包含标题与结构角色", passed: described, value: outline.length },
      { key: "architecture", label: "开场、命题顺序或组合方式已实质重建", passed: rebuilt, value: rebuilt ? `${rebuildSignals} 项结构信号` : `${rebuildSignals} 项，仍接近原结构` },
    ] satisfies RewriteValidationCheck[],
  };
}

export function validateRestructuredRewrite(units: ScriptUnit[], facts: RewriteFactCard[], paragraphs: string[], sourceFactIds: string[], outline: RewriteOutlineSection[]): RewriteValidation {
  const expectedFactIds = facts.map((item) => item.factId);
  const uniqueFactIds = new Set(sourceFactIds);
  const exactCoverage = sourceFactIds.length === expectedFactIds.length && uniqueFactIds.size === expectedFactIds.length && expectedFactIds.every((id) => uniqueFactIds.has(id));
  const base = baseValidation(units, paragraphs, "semantic");
  const plannedFactIds = outline.flatMap((item) => item.factIds);
  const followsPlan = plannedFactIds.length === sourceFactIds.length && plannedFactIds.every((id, index) => id === sourceFactIds[index]);
  const structureChanged = validateRestructurePlan(units, facts, outline).passed;
  const effectiveChangeCoveragePercent = Math.round((1 - base.sequenceSimilarity) * 1000) / 10;
  const maximumSequenceSimilarity = base.sourceNormalized.length < 160 ? 0.88 : 0.8;
  const minimumEffectiveChange = base.sourceNormalized.length < 160 ? 10 : 18;
  // Equivalent reconstruction protects the complete proposition ledger, not
  // repetition and filler inherited from the source transcript.
  const minimumLengthRatio = 0.5;
  const maximumLengthRatio = 1.25;
  const localCopy = inspectLocalRewriteCopy(units, paragraphs);
  const checks: RewriteValidationCheck[] = [];
  check(checks, "content", "稿件非空", paragraphs.length > 0 && Boolean(base.candidateNormalized), base.candidateNormalized.length);
  check(checks, "coverage", "全部命题完整且仅使用一次", exactCoverage, String(uniqueFactIds.size) + "/" + String(expectedFactIds.length));
  check(checks, "plan_execution", "正文按新提纲组织命题", followsPlan, followsPlan ? "一致" : "不一致");
  check(checks, "facts", "数字与专有标识完整", base.missingFacts.length === 0, base.missingFacts.length);
  check(checks, "no_new_facts", "未新增数字或专有标识", base.unexpectedFacts.length === 0, base.unexpectedFacts.length);
  check(checks, "length", "篇幅足以承载完整命题（原稿 50%—125%）", base.lengthRatio >= minimumLengthRatio && base.lengthRatio <= maximumLengthRatio, Number(base.lengthRatio.toFixed(3)));
  check(checks, "structure", "叙事结构已重建", structureChanged, structureChanged ? "已重建" : "未重建");
  check(checks, "sequence_difference", "不存在大段照搬或仅换段序", base.sequenceSimilarity <= maximumSequenceSimilarity, base.sequenceSimilarity.toFixed(3) + " / ≤" + String(maximumSequenceSimilarity));
  check(checks, "effective_change", "表达重写达到重构强度", effectiveChangeCoveragePercent >= minimumEffectiveChange, String(effectiveChangeCoveragePercent) + "% / ≥" + String(minimumEffectiveChange) + "%");
  check(checks, "local_copy", "不存在整句或整段照搬", localCopy.passed, localCopy.passed ? "未发现" : `${localCopy.copiedParagraphIndexes.length} 段，最长连续 ${localCopy.longestCopiedSpan} 字`);
  return {
    passed: checks.every((item) => item.passed), checks,
    lengthRatio: Number(base.lengthRatio.toFixed(4)),
    textSimilarity: Number(base.similarity.toFixed(4)),
    effectiveChangeCoveragePercent,
    changedParagraphPercent: paragraphs.length === units.length ? Math.round(paragraphs.filter((item, index) => normalizeRewriteText(item) !== normalizeRewriteText(units[index]?.text ?? "")).length / Math.max(1, units.length) * 100) : 100,
    missingImmutableFacts: base.missingFacts,
    unexpectedImmutableFacts: base.unexpectedFacts,
    sequenceSimilarity: Number(base.sequenceSimilarity.toFixed(4)),
    longestCopiedSpan: localCopy.longestCopiedSpan,
    copiedParagraphIndexes: localCopy.copiedParagraphIndexes,
    copiedSpans: localCopy.copiedSpans,
  };
}

export function rewriteValidationQualityScore(validation: RewriteValidation) {
  const passedChecks = validation.checks.filter((item) => item.passed).length;
  const factErrors = validation.missingImmutableFacts.length + (validation.unexpectedImmutableFacts?.length ?? 0);
  const copiedParagraphs = validation.copiedParagraphIndexes?.length ?? 0;
  const copiedSpan = validation.longestCopiedSpan ?? 0;
  const lengthDistance = validation.lengthRatio < 0.5
    ? 0.5 - validation.lengthRatio
    : validation.lengthRatio > 1.25
      ? validation.lengthRatio - 1.25
      : 0;
  return (validation.passed ? 1_000_000_000 : 0)
    + passedChecks * 1_000
    + validation.effectiveChangeCoveragePercent * 10
    - factErrors * 100_000
    - copiedParagraphs * 20_000
    - copiedSpan * 100
    - Math.round(lengthDistance * 100_000);
}

export function estimateRewriteUsage(sourceText: string, variants: ScriptRewriteVariant[]) {
  const units = buildScriptUnits(sourceText);
  const homomorphicUnits = buildMicroRewritePlan(buildScriptUnits(sourceText, SCRIPT_REWRITE_MAX_CHARACTERS)).workingUnits;
  const microBatches = variants.includes("light_rewrite")
    ? batchScriptUnits(homomorphicUnits, SCRIPT_REWRITE_MICRO_BATCH_CHARACTERS, SCRIPT_REWRITE_MICRO_BATCH_UNITS)
    : [];
  const sourceTokens = Math.max(1, Math.ceil(sourceText.length * 0.72));
  const lightCalls = microBatches.length ? microBatches.length + 1 : 0;
  const lightMaximumCalls = microBatches.length ? microBatches.length * (1 + SCRIPT_REWRITE_MICRO_REPAIR_ATTEMPTS) + 3 : 0;
  const restructureFactCalls = variants.includes("restructured") ? Math.max(1, batchScriptUnits(units, 5_000, 12).length) : 0;
  const restructureCalls = restructureFactCalls ? restructureFactCalls + 3 : 0;
  const restructureMaximumCalls = restructureFactCalls ? restructureFactCalls * 4 + 19 : 0;
  const callCount = lightCalls + restructureCalls;
  const maximumCallCount = lightMaximumCalls + restructureMaximumCalls;
  const estimatedInputTokens = (lightCalls ? sourceTokens * 2 + microBatches.length * 700 + 400 : 0) + (restructureCalls ? sourceTokens * 4 + 3_500 : 0);
  const averageFactBatchCharacters = sourceText.length / Math.max(1, restructureFactCalls);
  const lightBatchOutput = microBatches.reduce((total, batch) => {
    const characters = batch.reduce((sum, unit) => sum + unit.text.length, 0);
    return total + Math.min(13_000, Math.max(1_500, Math.ceil(characters * 1.15) + 1_000));
  }, 0);
  const lightBatchRepairOutput = microBatches.reduce((total, batch) => {
    const characters = batch.reduce((sum, unit) => sum + unit.text.length, 0);
    return total + Math.min(13_000, Math.max(1_800, Math.ceil(characters * 1.15) + 1_200));
  }, 0);
  const lightMaximumOutput = lightMaximumCalls
    ? lightBatchOutput
      + lightBatchRepairOutput * SCRIPT_REWRITE_MICRO_REPAIR_ATTEMPTS
      + Math.min(3_000, Math.max(1_000, homomorphicUnits.length * 160 + 700)) * 2
      + Math.min(13_000, Math.max(1_800, Math.ceil(sourceText.length * 1.15) + 1_200))
    : 0;
  const restructureMaximumOutput = restructureCalls
    ? restructureFactCalls * Math.min(8_000, Math.max(4_000, Math.ceil(averageFactBatchCharacters * 1.5) + 2_000))
      + restructureFactCalls * Math.min(8_000, Math.max(2_500, Math.ceil(averageFactBatchCharacters * 1.5) + 2_000))
      + restructureFactCalls * 2 * 3_000
      + 2 * 5_000
      + Math.min(7_000, Math.max(1_500, units.length * 300 + 1_200))
      + Math.min(7_000, Math.max(1_800, units.length * 340 + 1_400))
      + Math.min(13_000, Math.max(1_800, Math.ceil(sourceText.length * 1.25) + 1_200))
      + Math.min(6_000, Math.max(1_600, Math.ceil(sourceText.length * 0.65) + 900)) * 8
      + Math.min(13_000, Math.max(2_000, Math.ceil(sourceText.length * 1.25) + 1_400))
      + Math.min(2_500, Math.max(900, units.length * 180 + 600))
      + Math.min(8_000, Math.max(1_500, Math.ceil(sourceText.length * 1.3) + 800)) * 3
      + Math.min(2_500, Math.max(900, units.length * 180 + 600))
    : 0;
  const maximumOutputTokens = lightMaximumOutput + restructureMaximumOutput;
  return { sourceCharacters: sourceText.length, sourceTokens, unitCount: units.length, callCount, maximumCallCount, estimatedInputTokens, maximumOutputTokens };
}

export function readRewriteModelUsage(raw: unknown) {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  const usage = record?.usage && typeof record.usage === "object" ? record.usage as Record<string, unknown> : null;
  const inputTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0;
  const totalTokens = Number(usage?.total_tokens ?? inputTokens + outputTokens) || inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

export function rewriteVariantLabel(variant: ScriptRewriteVariant) {
  return variant === "light_rewrite" ? "微调同构" : "内容等价重构";
}
