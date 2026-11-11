import assert from "node:assert/strict";
import test from "node:test";
import { manuscriptAssetForVersion, parseManuscript, prefersStoredManuscript, scriptCaptions } from "../lib/manuscript-view.ts";

test("history binds the manuscript to this report's job and completion time", () => {
  const asset = (id, job, created_at) => ({ id, analysis_job_id: job, created_at, filename: "manuscript.json", kind: "subtitle", url: id });
  const assets = [asset("other-old", "other", "01"), asset("report", "job", "02"), asset("later-attempt", "job", "04"), asset("standalone", "extract", "05")];
  const analysis = { analysis_job_id: "job", created_at: "03" };
  assert.equal(manuscriptAssetForVersion(assets, analysis, true).id, "report");
  assert.equal(manuscriptAssetForVersion(assets, analysis, false).id, "standalone");
  assert.equal(manuscriptAssetForVersion(assets.slice(0, 1), analysis, true), undefined);
  const latest = { source: "manual", created_at: "06", segments: [] };
  assert.equal(prefersStoredManuscript(latest, assets.at(-1), analysis, false), true);
  assert.equal(prefersStoredManuscript(latest, assets[1], analysis, true), false);
  assert.equal(prefersStoredManuscript({ ...latest, created_at: "04" }, assets.at(-1), analysis, false), false);
});

test("copy/edit sentences and VTT share corrected words, and original recognition stays accessible", () => {
  const document = { version: "manuscript.v1", basis: "audio",
    segments: [{ text: "逐字稿 <A>", start_ms: 280, end_ms: 315 }, { text: "下一句", start_ms: 320, end_ms: 945 }],
    subtitle_evidence: { "transcript:0001": { source_text: "竹子稿", text: "逐字稿 <A>" } } };
  const manuscript = parseManuscript(document);
  assert.equal(manuscript.segments.map(r => r.text).join("\n"), "逐字稿 <A>\n下一句");
  assert.equal(manuscript.originals[0].text, "竹子稿");
  const vtt = decodeURIComponent(scriptCaptions(manuscript.segments)).split(",")[1];
  assert.match(vtt, /00:00:00\.280 --> 00:00:00\.315\n逐字稿 &lt;A&gt;/);
  assert.doesNotMatch(vtt, /竹子稿/);
  assert.throws(() => parseManuscript({ ...document, segments: [{ text: "坏数据", start_ms: 1000, end_ms: 400 }] }));
});

test("unpunctuated local ASR gets reading paragraphs without changing the source words", async () => {
  const { manuscriptParagraphs } = await import("../lib/manuscript-view.ts");
  const rows = Array.from({ length: 30 }, (_, n) => ({ startMs: n * 1000, endMs: n * 1000 + 900, text: "逐字稿包含原声词" }));
  const paragraphs = manuscriptParagraphs(rows);
  assert.ok(paragraphs.length > 1 && paragraphs.length < rows.length);
  assert.equal(paragraphs.join("").replaceAll(" ", ""), rows.map(row => row.text).join(""));
});
