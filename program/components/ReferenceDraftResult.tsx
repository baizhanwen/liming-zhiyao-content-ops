import type { ProductionPack } from "../lib/content-production";
import type { ReferenceCreationReport } from "../lib/structure-creation";
import { DraftStoryboard } from "./DraftStoryboard";

type Shot = ProductionPack["storyboard"][number];

function narrationKey(text: string) {
  return text.normalize("NFKC").replace(/[\s“”‘’「」『』"'。!?！？,，、;；:：]+/gu, "");
}

function groupShots(segments: ReferenceCreationReport["segments"], shots: Shot[]) {
  const groups = new Map(segments.map(segment => [segment.segmentId, [] as Shot[]]));
  const unassigned: Shot[] = [];
  const passages = segments.map(segment => [
    segment.spokenText, segment.screenText, segment.originalSound,
    ...(segment.table?.columns ?? []), ...(segment.table?.rows.flat() ?? []),
  ].filter(Boolean).map(narrationKey));
  const matches = (fragment: string, minLength: number) => passages.flatMap((fields, index) =>
    fields.some(field => field === fragment || (fragment.length >= minLength && field.includes(fragment))) ? [index] : []);

  for (const shot of shots) {
    if (shot.segmentId) {
      (groups.get(shot.segmentId) ?? unassigned).push(shot);
      continue;
    }
    // Older drafts have no segmentId. A plain shot number describes its place in the film only.
    const number = /^(\d+)-\d+$/u.exec(shot.shot);
    const labeled = number ? Number(number[1]) - 1 : -1;
    const script = shot.script ?? "";
    const line = narrationKey(script);
    let owners = line ? matches(line, 8) : [];
    if (!owners.length && line) {
      // A partial quotation needs substantial verbatim evidence from a single segment.
      const clauses = script.split(/[。！？!?；;，,：:\n]+/u).map(narrationKey).filter(clause => clause.length >= 4);
      const candidates = clauses.map(clause => ({ length: clause.length, owners: matches(clause, 4) }));
      const matchedLength = candidates.reduce((sum, part) => sum + (part.owners.length ? part.length : 0), 0);
      if (matchedLength >= line.length / 2 && candidates.some(part => part.length >= 8 && part.owners.length > 0)) {
        owners = [...new Set(candidates.flatMap(part => part.owners))];
      }
    }
    let owner = -1;
    if (number) {
      if (segments[labeled] && (!owners.length || owners.includes(labeled))) owner = labeled;
    } else if (owners.length === 1) owner = owners[0];
    (groups.get(segments[owner]?.segmentId) ?? unassigned).push(shot);
  }
  return { groups, unassigned };
}

export function ReferenceDraftResult({ report, storyboard = [] }: { report: ReferenceCreationReport; storyboard?: Shot[] }) {
  const { groups, unassigned } = groupShots(report.segments, storyboard);
  return <section className="reference-delivery" aria-label="逐段成稿">
    <header className="reference-delivery-heading">
      <h3>{report.scriptEdited ? "生成时的逐段成稿" : "逐段成稿"}</h3>
      {report.focus && <p><strong>本版写作重点</strong> {report.focus}</p>}
      {report.scriptEdited && <p>正文已手动修订。下方展示生成时的逐段内容与分镜。</p>}
      {report.productionBasis && report.productionBasis.length > 0 && <details>
        <summary>查看这版采用的策略、写作方法和参考结构</summary>
        <ul>{report.productionBasis.map(source => <li key={source.sourceId}><strong>{source.purpose}</strong> {source.quote}</li>)}</ul>
      </details>}
    </header>
    {report.segments.map((segment, index) => <article className="reference-delivery-segment" key={segment.segmentId}>
      <h4 className="reference-delivery-role">
        <span className="reference-delivery-number">第 {index + 1} 段</span>
        <span>{segment.role}</span>
      </h4>
      {(segment.spokenText || segment.screenText || segment.originalSound) && <dl className="reference-delivery-copy">
        {[
          ["口播", segment.spokenText],
          ["上屏", segment.screenText],
          ["原声", segment.originalSound],
        ].map(([label, content]) => content && <div key={label}>
          <dt>{label}</dt>
          <dd>{content}</dd>
        </div>)}
      </dl>}
      {segment.table && <div className="reference-table-scroll"><table><caption>上屏表格</caption>
        <thead><tr>{segment.table.columns.map((cell, i) => <th key={i} scope="col">{cell}</th>)}</tr></thead>
        <tbody>{segment.table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
      </table></div>}
      <DraftStoryboard shots={groups.get(segment.segmentId)} />
    </article>)}
    <DraftStoryboard title="未关联段落的分镜" shots={unassigned} />
  </section>;
}
