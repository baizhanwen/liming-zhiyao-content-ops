export type ComparableProjectMemory = {
  title: string;
  content: string;
};

function normalizedSemanticText(value: string) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigramFrequency(value: string) {
  const normalized = normalizedSemanticText(value);
  const result = new Map<string, number>();
  if (normalized.length < 2) {
    if (normalized) result.set(normalized, 1);
    return result;
  }
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const gram = normalized.slice(index, index + 2);
    result.set(gram, (result.get(gram) ?? 0) + 1);
  }
  return result;
}

function diceCoefficient(left: string, right: string) {
  const leftGrams = bigramFrequency(left);
  const rightGrams = bigramFrequency(right);
  let leftSize = 0;
  let rightSize = 0;
  let intersection = 0;
  for (const count of leftGrams.values()) leftSize += count;
  for (const count of rightGrams.values()) rightSize += count;
  if (!leftSize || !rightSize) return normalizedSemanticText(left) === normalizedSemanticText(right) ? 1 : 0;
  for (const [gram, count] of leftGrams) intersection += Math.min(count, rightGrams.get(gram) ?? 0);
  return (2 * intersection) / (leftSize + rightSize);
}

export function projectMemorySimilarity(left: ComparableProjectMemory, right: ComparableProjectMemory) {
  const title = diceCoefficient(left.title, right.title);
  const content = diceCoefficient(left.content, right.content);
  return { title, content, combined: title * 0.55 + content * 0.45 };
}

export function areProjectMemoriesEquivalent(left: ComparableProjectMemory, right: ComparableProjectMemory) {
  const score = projectMemorySimilarity(left, right);
  return score.title >= 0.52
    || score.content >= 0.62
    || (score.title >= 0.24 && score.content >= 0.38 && score.combined >= 0.34);
}
