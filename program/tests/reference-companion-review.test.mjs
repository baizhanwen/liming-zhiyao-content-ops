import assert from "node:assert/strict";
import test from "node:test";
import { createProductionScaffold } from "../lib/content-production.ts";
import { applyReferenceCompanionEdits, buildReferenceCompanionTexts } from "../lib/reference-companion-review.ts";

function example() {
  const before = "我这才发现，果然应该慢下来。";
  const after = "错题本上，昨天漏掉的负号被圈了出来。";
  const pack = createProductionScaffold({ id: "topic", title: "期末周的一天" });
  const report = {
    videoId: "video", analysisId: "analysis", topicMode: "reference", topic: "期末周的一天",
    segments: [{ segmentId: "middle", role: "转折", presentation: "both", materialIds: [], note: "",
      spokenText: before, screenText: before, originalSound: "", table: null }],
  };
  const reviewed = structuredClone(report);
  Object.assign(reviewed.segments[0], { spokenText: after, screenText: "圈出的负号" });
  pack.referenceCreation = report;
  pack.storyboard[0].script = before;
  pack.shortScript = "广播响了。\n" + before;
  pack.adaptations = [{ platform: "抖音", copy: "突然想通了慢下来的道理。" }];
  pack.subtitleHighlights = ["旧稿的上屏重点"];
  pack.coverCopy = ["刚听到广播的时候"];
  return { before, after, pack, report, reviewed };
}

test("配套文案按既有字段校正，保留画面、时长、原始稿和制作依据", () => {
  const { before, after, pack, report, reviewed } = example();
  const fields = buildReferenceCompanionTexts(pack);
  assert.ok(fields.some(row => row.fieldId === "adaptations.0.copy"));
  assert.ok(!fields.some(row => /source|citation|durationSec|qualityReview|\.platform/.test(row.fieldId)));
  const updated = applyReferenceCompanionEdits(pack, report, reviewed, [
    { fieldId: "adaptations.0.copy", text: "闭馆广播之后，听得见合书声。" },
  ]);
  assert.equal(updated.shortScript, "广播响了。\n" + after);
  assert.deepEqual(updated.storyboard, [{ ...pack.storyboard[0], script: after }]);
  assert.deepEqual(updated.adaptations, [{ platform: "抖音", copy: "闭馆广播之后，听得见合书声。" }]);
  assert.deepEqual(updated.citations, pack.citations);
  assert.deepEqual(updated.qualityReview, pack.qualityReview);
  assert.equal(pack.storyboard[0].script, before);
});

test("配套文案可以独立校正，不用截断未改段或猜测有歧义的同句", () => {
  const { before, pack, report, reviewed } = example();
  report.segments.push({ ...report.segments[0], segmentId: "another" });
  reviewed.segments.push({ ...report.segments[1] });
  const updated = applyReferenceCompanionEdits(pack, report, reviewed, [{ fieldId: "shortScript", text: "图书馆的广播响起来了。" }]);
  assert.equal(updated.storyboard[0].script, before);
  assert.equal(updated.shortScript, "图书馆的广播响起来了。");
  const companionOnly = applyReferenceCompanionEdits(pack, report, report, [{ fieldId: "subtitleHighlights.0", text: "现场广播" }]);
  assert.deepEqual(companionOnly.subtitleHighlights, ["现场广播"]);
  assert.equal(companionOnly.shortScript, pack.shortScript);
});

test("带口播与多行上屏标记的分镜同步到各自的终稿，保留短稿中其他已审文字", () => {
  const { before, after, pack, report, reviewed } = example();
  report.segments[0].screenText = "旧的第一行\n旧的第二行";
  reviewed.segments[0].screenText = "圈出的负号\n两遍解法";
  pack.storyboard[0].script = `【口播】${before}\n【上屏】旧的第一行\n旧的第二行`;
  const edited = `新的镜头说明。\n旁白：${before}\n字幕：旧的第一行\n旧的第二行`;
  const updated = applyReferenceCompanionEdits(pack, report, reviewed, [{ fieldId: "shortScript", text: edited }]);
  assert.equal(updated.storyboard[0].script, `【口播】${after}\n【上屏】圈出的负号\n两遍解法`);
  assert.equal(updated.shortScript, `新的镜头说明。\n旁白：${after}\n字幕：圈出的负号\n两遍解法`);
});

test("拒绝不存在、越权、重复或过长的字段，静音镜头允许清空台词", () => {
  const { pack, report } = example();
  for (const fieldId of ["storyboard.5.script", "__proto__.name", "citations.0.quote", "storyboard.0.durationSec"]) {
    assert.throws(() => applyReferenceCompanionEdits(pack, report, report, [{ fieldId, text: "新内容" }]));
  }
  const edit = { fieldId: "shortScript", text: "新的短稿。" };
  for (const edits of [[edit, edit], [{ ...edit, text: "" }], [{ fieldId: "coverCopy.0", text: "长".repeat(121) }]]) {
    assert.throws(() => applyReferenceCompanionEdits(pack, report, report, edits));
  }
  assert.equal(applyReferenceCompanionEdits(pack, report, report, [{ fieldId: "storyboard.0.script", text: "" }]).storyboard[0].script, "");
});
