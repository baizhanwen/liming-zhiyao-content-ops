import type { ReferenceCreationReport } from "./structure-creation.ts";

type Section = { id: string; text: string };
type Sentence = { original: string; plain: string };
type Match = { phrase: string; earlierExcerpt: string; laterExcerpt: string };
export type ReferenceOverlapHint = {
  earlier: string; later: string; kind: "same_sentence" | "several_phrases" | "shared_phrase";
  matches: Match[];
};

const plain = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

function excerpt(sentence: string, phrase: string) {
  const start = Math.max(0, sentence.indexOf(phrase) - 35);
  return sentence.slice(start, start + 180);
}

function indexSection(section: Section) {
  const sentences = section.text.split(/[。！？!?；;\n]+/u).map(original => ({ original: original.trim(), plain: plain(original) }))
    .filter(sentence => sentence.plain.length >= 4);
  const starts = new Map<string, Array<{ sentence: Sentence; offset: number }>>();
  for (const sentence of sentences) {
    for (let offset = 0; offset <= sentence.plain.length - 4; offset++) {
      const key = sentence.plain.slice(offset, offset + 4);
      const hits = starts.get(key);
      if (!hits) starts.set(key, [{ sentence, offset }]);
      else if (hits.length < 3) hits.push({ sentence, offset });
    }
  }
  return { id: section.id, sentences, starts };
}

function repeatedDetails(earlier: ReturnType<typeof indexSection>, later: ReturnType<typeof indexSection>): ReferenceOverlapHint | null {
  const fragments = new Map<string, Match>();
  let sameSentence = false;
  for (const sentence of later.sentences) {
    for (let pos = 0; pos <= sentence.plain.length - 4; pos++) {
      const hits = earlier.starts.get(sentence.plain.slice(pos, pos + 4));
      if (!hits) continue;
      for (const hit of hits) {
        // The start of a run records its full match; the next offsets need not repeat it.
        if (pos > 0 && hit.offset > 0 && sentence.plain[pos - 1] === hit.sentence.plain[hit.offset - 1]) continue;
        let length = 4;
        while (length < 60 && pos + length < sentence.plain.length &&
          sentence.plain[pos + length] === hit.sentence.plain[hit.offset + length]) length++;
        const phrase = sentence.plain.slice(pos, pos + length);
        if (!fragments.has(phrase)) fragments.set(phrase, {
          phrase, earlierExcerpt: excerpt(hit.sentence.original, phrase), laterExcerpt: excerpt(sentence.original, phrase),
        });
        if (length >= 10 && sentence.plain === hit.sentence.plain) sameSentence = true;
      }
    }
  }
  const matches: Match[] = [];
  for (const hit of [...fragments.values()].sort((a, b) => b.phrase.length - a.phrase.length)) {
    if (!matches.some(longer => longer.phrase.includes(hit.phrase))) matches.push(hit);
    if (matches.length === 3) break;
  }
  if (!matches.length) return null;
  const [first, second] = matches;
  // A shared prop name or ordinary repeated word on its own has no diagnostic value.
  const several = second && first.phrase.length + second.phrase.length >= 11;
  if (!several && first.phrase.length < 8) return null;
  return { earlier: earlier.id, later: later.id, kind: sameSentence ? "same_sentence" : several ? "several_phrases" : "shared_phrase", matches };
}

function middleOverlaps(sections: Section[]) {
  const rows = sections.map(indexSection);
  const hints: ReferenceOverlapHint[] = [];
  // Check every middle against preceding sections, keeping deliberate closing callbacks out of this signal.
  for (let later = 1; later < rows.length - 1; later++) {
    for (let earlier = 0; earlier < later; earlier++) {
      const hint = repeatedDetails(rows[earlier], rows[later]);
      if (hint) hints.push(hint);
    }
  }
  // Show stronger examples first and cap the extra model context for long scripts.
  const priority = { same_sentence: 3, several_phrases: 2, shared_phrase: 1 };
  return hints.sort((a, b) => priority[b.kind] - priority[a.kind]).slice(0, 16);
}

/** Evidence for semantic editing, not a decision to delete. Never compare different output channels against one another. */
export function buildReferenceOverlapHints(report: ReferenceCreationReport, companionTexts: readonly { fieldId: string; text: string }[] = []) {
  const manuscript = report.segments.map(row => ({ id: row.segmentId, text: row.spokenText || row.screenText || "" }));
  const shotScripts = companionTexts.filter(row => /^storyboard\.\d+\.script$/u.test(row.fieldId))
    .map(row => ({ id: row.fieldId, text: row.text }));
  return [...middleOverlaps(manuscript), ...middleOverlaps(shotScripts)];
}
