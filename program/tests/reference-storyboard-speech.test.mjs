import assert from "node:assert/strict";
import test from "node:test";
import { alignReferenceStoryboardSpeech } from "../lib/reference-storyboard-speech.ts";

const segment = (segmentId, spokenText, note = "") => ({ segmentId, spokenText, note });
const shot = (script, i) => ({ shot: `镜头${i}`, visual: `继续第${i}个画面`, script, performance: "慢推", durationSec: 4 });
const call = (oldRows, newRows, texts) => alignReferenceStoryboardSpeech(
  { segments: oldRows }, { segments: newRows }, texts.map(shot),
);

test("相邻镜头照读同一段完整旁白保留一次，保留画面和静音尾段", () => {
  const rows = [segment("a", "镜头里能看到被圈出来的负号。"), segment("b", "")];
  const texts = [rows[0].spokenText, " ", rows[0].spokenText, ""];
  const result = call(rows, rows, texts);
  assert.deepEqual(result.map(s => s.script), [texts[0], " ", "", ""]);
  assert.deepEqual(result, texts.map(shot).map((row, i) => i === 2 ? { ...row, script: "" } : row));
});

test("中段拆了两个镜头，复核把新版完整旁白放在一个镜头后，另一个镜头的已删原句停止复读", () => {
  const oldDetail = "同一道题，我写了两遍。昨天漏掉的负号，被今天的笔圈了出来。";
  const plan = "计划表上先写两页新题，后来改成一道旧题。";
  const finalDetail = "错题本摊在桌上。昨天和今天有两遍解法，漏写的负号被圈了出来。";
  const old = [segment("plan", "一开始打算做两页新题。" + oldDetail), segment("detail", "我决定去重新检查昨天的遗漏。"), segment("tail", "")];
  const revised = [segment("plan", plan), segment("detail", finalDetail), segment("tail", "")];
  const result = call(old, revised, [plan, oldDetail, finalDetail, ""]);
  assert.deepEqual(result.map(s => s.script), [plan, "", finalDetail, ""]);
});

test("多段有意说同一句、明确要求复读、已确认旁白正常拆镜都保持原样", () => {
  const echo = "不知道的时候先把资料拿出来。";
  const separateRows = [segment("open", echo), segment("close", echo)];
  assert.deepEqual(call(separateRows, separateRows, [echo, echo]).map(s => s.script), [echo, echo]);
  const repeated = [segment("open", echo, "两个镜头的旁白都要重复这句。")];
  assert.deepEqual(call(repeated, repeated, [echo, echo]).map(s => s.script), [echo, echo]);
  const parts = ["同一道题有昨天和今天两遍解法。", "昨天漏写的负号被圈住了。"];
  const whole = [segment("open", parts.join(""))];
  assert.deepEqual(call(whole, whole, parts).map(s => s.script), parts);
  const silent = [segment("screen", ""), segment("original", "")];
  assert.deepEqual(call(silent, silent, ["", ""]).map(s => s.script), ["", ""]);
});

test("否定复读指示仍去重，结尾明确要求再念一遍只影响对应段落", () => {
  const opening = "图书馆到了收书的时间。", ending = "请带好自己的随身物品。";
  for (const note of ["不要重复这句话", "避免旁白再说一遍", "不用再念一遍"]) {
    const rows = [segment("a", opening, note)];
    assert.deepEqual(call(rows, rows, [opening, opening]).map(s => s.script), [opening, ""]);
  }
  const rows = [segment("a", opening), segment("b", ending)];
  const focus = "开头不要重复原句，但结尾要再念一遍。";
  const result = alignReferenceStoryboardSpeech({ segments: rows }, { segments: rows, focus },
    [opening, opening, ending, ending].map(shot));
  assert.deepEqual(result.map(s => s.script), [opening, "", ending, ending]);
});

test("某段唯一有声镜头仍念已删完整旧句，按已确认旁白更新，静音镜头原样保留", () => {
  const stale = "听见广播，我停了一下。";
  const old = [segment("a", stale + "桌上还摊着错题本。"), segment("b", "回到圈出的负号。")];
  const updated = [segment("a", "听见广播，我松了一口气。"), old[1]];
  const shots = [{ ...shot(stale, 1), shot: "1-1" }, { ...shot("", 2), shot: "1-2" }, { ...shot(old[1].spokenText, 3), shot: "2-1" }];
  const fixed = alignReferenceStoryboardSpeech({ segments: old }, { segments: updated }, shots);
  assert.deepEqual(fixed, [{ ...shots[0], script: updated[0].spokenText }, ...shots.slice(1)]);
  assert.deepEqual(call(old, updated, [stale, old[1].spokenText]).map(s => s.script), [updated[0].spokenText, old[1].spokenText]);
  assert.deepEqual(call(old, updated, [stale, "桌上还摊着错题本。", old[1].spokenText]).map(s => s.script),
    [stale, "桌上还摊着错题本。", old[1].spokenText]);
  assert.deepEqual(call(old, updated, ["广播，我停", old[1].spokenText]).map(s => s.script), ["广播，我停", old[1].spokenText]);
});

test("两段有相同旧旁白时按显式分镜归属同步，保留另一段原句和镜头顺序", () => {
  const echo = "先把两页资料摊在桌面上。";
  const updated = "把两页资料的页码记下来。";
  const old = [segment("first", echo), segment("second", echo)];
  const reviewed = [segment("first", updated), old[1]];
  const shots = [{ ...shot(echo, 1), segmentId: "second" }, { ...shot(echo, 2), segmentId: "first" }];
  assert.deepEqual(alignReferenceStoryboardSpeech({ segments: old }, { segments: reviewed }, shots), [
    shots[0], { ...shots[1], script: updated },
  ]);
});
