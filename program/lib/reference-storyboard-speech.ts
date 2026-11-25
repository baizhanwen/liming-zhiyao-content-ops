import type { ProductionPack } from "./content-production.ts";
import type { ReferenceCreationReport } from "./structure-creation.ts";

const scriptKey = (text: string) => text.normalize("NFKC").replace(/\s+/gu, "");
const repeatDirection = /(?:复读|重复|复述|重念|再(?:说|念|读|讲)一?[次遍]|(?:说|念|读|讲)[两二三多几\d]+[次遍])/gu;

function requestsRepeat(text: string, index = -1, count = 0) {
  const clauses = text.split(/[，,。；;！？!?\n]|(?:但是|不过|而是|改为|但)/u);
  return clauses.some(clause => {
    if (index >= 0) {
      const opening = /开头|开场|首段|第一段/u.test(clause);
      const ending = /结尾|收尾|片尾|尾段|最后一段/u.test(clause);
      if ((opening || ending) && !(opening && index === 0) && !(ending && index === count - 1)) return false;
    }
    for (const match of clause.matchAll(repeatDirection)) {
      const before = clause.slice(0, match.index), after = clause.slice(match.index + match[0].length);
      if (/(?:勿|别|禁止|避免|防止|不再|不想|不要|不用|不得|不必|不许|不该|不需要|无需|无须|去掉|减少|删掉)[^。；，]{0,16}$|不$/u.test(before) ||
          /^(?:太多|过多|啰嗦|的问题|的毛病|是不必要的)/u.test(after)) continue;
      if (/^(?:再|重念|(?:说|念|读|讲).+[次遍])/u.test(match[0]) ||
          /(?:请|要|须|让|建议|刻意|特意|故意|允许|需要|可以|务必|记得|旁白|台词|原话|这句|字幕)/u.test(before) ||
          /^(?:这句|原话|同一句|一遍|两遍|一次|两次)/u.test(after)) return true;
    }
    return false;
  });
}

function isWholePassage(line: string, excerpt: string) {
  if (line === excerpt) return true;
  const start = line.indexOf(excerpt);
  const sentenceEnd = /[。.!！？?…]["'”’」）)]*$/u;
  return start >= 0 && (start === 0 || sentenceEnd.test(line.slice(0, start))) &&
    (start + excerpt.length === line.length || sentenceEnd.test(excerpt));
}

function syncSingleVoiceovers(previous: ReferenceCreationReport, reviewed: ReferenceCreationReport, shots: ProductionPack["storyboard"]) {
  const rows = reviewed.segments;
  const old = previous.segments.map(r => scriptKey(r.spokenText));
  const current = rows.map(r => scriptKey(r.spokenText));
  const labels = shots.map(shot => Number(/^(\d+)-\d+$/u.exec(shot.shot)?.[1]) - 1);
  const numbered = labels.every((i, k) => i >= 0 && i < rows.length && (k === 0 || i >= labels[k - 1]));
  const owners = shots.map((shot, k) => {
    const script = scriptKey(shot.script);
    if (!script) return null;
    if (shot.segmentId) return rows.findIndex(row => row.segmentId === shot.segmentId);
    const candidates = current.flatMap((line, i) => old[i].includes(script) || line.includes(script) ? [i] : []);
    if (numbered && (!candidates.length || candidates.includes(labels[k]))) return labels[k];
    return candidates.length === 1 ? candidates[0] : -1;
  });
  // Without a consistent shot label or a textual match we cannot know if a second clip speaks this part.
  if (owners.includes(-1)) return shots;
  return shots.map((shot, k) => {
    const i = owners[k];
    if (i === null || owners.indexOf(i) !== owners.lastIndexOf(i) || !current[i] || current[i] === old[i]) return shot;
    const script = scriptKey(shot.script);
    if (current[i].includes(script) || !isWholePassage(old[i], script)) return shot;
    return { ...shot, script: rows[i].spokenText };
  });
}

/** Preserve the shot sequence while preventing a complete approved voiceover from playing twice. */
export function alignReferenceStoryboardSpeech(
  previous: ReferenceCreationReport,
  reviewed: ReferenceCreationReport,
  shots: ProductionPack["storyboard"],
) {
  const lines = reviewed.segments.map(row => scriptKey(row.spokenText));
  const previousLines = new Map(previous.segments.map(row => [row.segmentId, scriptKey(row.spokenText)]));
  const scripts = shots.map(shot => scriptKey(shot.script));
  const silent = new Set<number>();
  for (const [index, row] of reviewed.segments.entries()) {
    const line = lines[index];
    if (!line || requestsRepeat(row.note) || requestsRepeat(reviewed.focus ?? "", index, lines.length)
        || lines.some((other, i) => i !== index && other.includes(line))) continue;
    const old = previousLines.get(row.segmentId);
    let group: number[] = [];
    const settle = () => {
      const complete = group.find(i => scripts[i] === line);
      if (complete !== undefined) for (const i of group) if (i !== complete) silent.add(i);
      group = [];
    };
    for (const [i, script] of scripts.entries()) {
      if (shots[i].segmentId && shots[i].segmentId !== row.segmentId) {
        settle();
        continue;
      }
      if (!script) continue;
      // A contiguous multi-shot narration may have left behind a verbatim piece of its old line.
      // Only claim fragments with a unique source segment and keep any wording used elsewhere.
      const belongsToAnother = lines.some((other, j) => j !== index && other.includes(script));
      const leftover = old && old !== line && script.length >= 8 && old.includes(script)
        && !belongsToAnother && !previous.segments.some(other => other.segmentId !== row.segmentId && previousLines.get(other.segmentId)?.includes(script));
      if (script === line || leftover) group.push(i);
      else settle();
    }
    settle();
  }
  const deduplicated = silent.size ? shots.map((shot, i) => silent.has(i) ? { ...shot, script: "" } : shot) : shots;
  return syncSingleVoiceovers(previous, reviewed, deduplicated);
}
