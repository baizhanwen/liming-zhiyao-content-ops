import assert from "node:assert/strict";
import test from "node:test";
import { analyzeVideoComments } from "../lib/video-comment-insights.ts";

const row = (text, like_count = null, has_image = false) => ({ text, like_count, has_image });

test("counts mentions once per comment and returns traceable original ranks without reordering", () => {
  const input = [
    row("奖金奖金，奖金"), row("Tim 今天展示了相机"), row("正片是哪一集？"),
    row("奖金和 TIM 多次被提到"), row("正片里也看到了 tim"), row("道具道具道具"),
  ];
  const result = analyzeVideoComments(input);
  assert.deepEqual(result.topics, [
    { term: "Tim", ranks: [2, 4, 5] },
    { term: "奖金", ranks: [1, 4] },
    { term: "正片", ranks: [3, 5] },
  ]);
  assert.deepEqual(result.questionRanks, [3]);
  assert.equal(result.textCount, 6);
});

test("flags explicit questions and requests, excluding self-answered, rhetorical or emoji-only comments", () => {
  const { questionRanks } = analyzeVideoComments([
    row("请问这个设备支持竖屏吗"), row("求教程"), row("导出以后在哪里找？"),
    row("奖金什么概念，这么说吧，这比去年的多"), row("为什么会卡？因为缓存满了。"),
    row("？？？"), row("[捂脸]？"), row("这不是正片里的吗？"), row("懂了，知道怎么操作了"),
    row("我可以分享我做的笔记"), row("怎么说呢，节奏很快"), row("What I liked was the ending."),
  ]);
  assert.deepEqual(questionRanks, [1, 2, 3]);
});

test("empty samples and mixed media stay distinct; highest observed positive likes keep all ties", () => {
  assert.deepEqual(analyzeVideoComments([]), { topics: [], questionRanks: [], topLikedRanks: [], textCount: 0 });
  assert.deepEqual(analyzeVideoComments([
    row("", 8, true), row("😂[捂脸]"), row("@小王 https://example.invalid/path", 1), row("不错", 8), row("[爱心]", 0),
  ]), { topics: [], questionRanks: [], topLikedRanks: [1, 4], textCount: 1 });
  assert.deepEqual(analyzeVideoComments([row("看看", 0), row("好")]).topLikedRanks, []);
});

test("numbers, URLs, @mentions, high repetition inside one comment and conversational filler do not become topics", () => {
  const { topics } = analyzeVideoComments([
    row("@主播 100w 666 这个真的可以 哈哈哈 URLURLURL"),
    row("@主播 100w 666 这个真的可以 哈哈哈 https://example.invalid"),
    row("https://example.invalid"),
  ]);
  assert.deepEqual(topics, []);
});

test("keeps names with directly attached honorifics intact", () => {
  assert.deepEqual(analyzeVideoComments([row("野兽先生来了"), row("野兽先生")]).topics, [
    { term: "野兽先生", ranks: [1, 2] },
  ]);
});

test("an engine without word segmentation keeps bounded ASCII topics and question evidence", t => {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
  t.after(() => { Object.defineProperty(Intl, "Segmenter", descriptor); });
  Object.defineProperty(Intl, "Segmenter", { ...descriptor, value: undefined });
  const { topics, questionRanks } = analyzeVideoComments([
    row("PR 剪辑，PR PR"), row("请问 pr 能用吗"), row("剪辑剪辑"),
  ]);
  assert.deepEqual(topics, [{ term: "PR", ranks: [1, 2] }]);
  assert.deepEqual(questionRanks, [2]);
});
