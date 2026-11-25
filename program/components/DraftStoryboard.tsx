import type { ProductionPack } from "../lib/content-production";

export function DraftStoryboard({ shots, title = "分镜" }: {
  shots?: ProductionPack["storyboard"];
  title?: string;
}) {
  if (!shots?.length) return null;
  return <section className="draft-storyboard" aria-label={title}>
    <div className="draft-storyboard-label">{title}</div>
    <ol>
      {shots.map((shot, index) => <li key={`${index}-${shot.shot}`}>
        <div className="draft-shot-meta"><strong>{shot.shot}</strong><span>{shot.durationSec} 秒</span></div>
        <div className="draft-shot-directions">
          <p>{shot.visual}</p>
          {shot.performance && <p className="draft-shot-performance">{shot.performance}</p>}
        </div>
      </li>)}
    </ol>
  </section>;
}
