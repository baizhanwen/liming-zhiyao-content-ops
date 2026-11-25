import type { PlatformComment } from "./video-platform-comments";

type Mention = { term: string; ranks: number[] };
export type VideoCommentInsights = {
  topics: Mention[];
  questionRanks: number[];
  topLikedRanks: number[];
  textCount: number;
};

// Broad conversational words recur even in comments about completely different things.
const stopWords = new Set((
  "这个 那个 这些 那些 这种 那种 这样 那样 这类 那类 这里 那里 我们 你们 他们 你自己 自己 别人 大家 人家 " +
  "什么 怎么 如何 为啥 为什么 哪个 哪里 多少 请问 可以 不能 应该 可能 需要 知道 觉得 感觉 真的 确实 好像 " +
  "其实 但是 不过 所以 因为 如果 就算 虽然 既然 而且 而是 非常 特别 比较 还是 已经 然后 一直 一样 " +
  "一个 一下 一点 一个个 第一 最后 之前 之后 现在 不是 就是 也是 只是 就会 不会 没有 还有 这么 那么 " +
  "谢谢 感谢 哈哈 哈哈哈 视频 评论 作者 博主 我看 这位 那位 一位 先生 女士 " +
  "the a an and or of on in is it to for with this that what how why are you not can i have be my me"
).split(" "));

function readableText(text: string) {
  return text.normalize("NFKC")
    .replace(/https?:\/\/[^\s,，。！？；]+/giu, " ")
    .replace(/@[\p{L}\p{N}_.·-]+/gu, " ")
    .replace(/\[(?:表情|图片|贴纸|捂脸|捂脸哭|笑哭|赞|赞同|爱心|比心|流泪|呲牙|偷笑|大笑|鼓掌|看|doge|尬笑|害羞|微笑|坏笑|泪奔|抱抱|灵机一动|强|发呆|发怒|惊呆|吃瓜|暗中观察|抠鼻)\]/giu, " ")
    .trim();
}

function hasQuestion(text: string) {
  if (!/\p{L}/u.test(text)) return false;
  if (/[?，,。；;]\s*(?:答案(?:就)?是|因为|这么说吧|我来告诉你|我来回答|我来解答)/u.test(text)) return false;
  return (text.match(/[^。！？!?\n]+[?]?/gu) ?? []).some(sentence => {
    const clause = sentence.trim();
    if (/(?:难道|何必|谁不(?:知道|喜欢|想)|那还用问|这还用问|这不是.{1,40}吗|^怎么说呢)/u.test(clause)) return false;
    if (/(?:请问|想请教|有人知道|有谁知道|求教|求助|求教程|求链接|求推荐|能不能分享|能否分享)/u.test(clause)) return true;
    if (/^(?:怎么|怎样|如何|为什么|为啥|哪里|哪儿|哪个|有没有|能不能|可不可以)/u.test(clause)) return true;
    if (/^(?:when|where|how|why|what)\b.*\?$/iu.test(clause)) return true;
    return /(?:吗|么|嘛)[?]?$/u.test(clause) || (/[?]$/u.test(clause) && /(?:哪|谁|几|多少|什么|怎么|如何|能否|能不能|是不是|有没有|还会|可以|\b(?:can|is|are|do|does|did|could|will|would)\b)/iu.test(clause));
  });
}

function termsIn(text: string, segmenter: Intl.Segmenter | undefined): string[] {
  // Give up Chinese word extraction when ICU dictionaries are unavailable. ASCII terms still have clear boundaries.
  const words = segmenter ? Array.from(segmenter.segment(text), ({ segment, index, isWordLike }) => {
    if (!isWordLike || stopWords.has(segment)) return "";
    // ICU separates names such as 野兽先生 into two words; preserve a directly attached honorific.
    if (/^\p{Script=Han}{1,8}$/u.test(segment)) {
      const suffix = text.slice(index + segment.length, index + segment.length + 2);
      if (suffix === "先生" || suffix === "女士") return segment + suffix;
    }
    return segment;
  }) : (text.match(/[A-Za-z0-9]+/g) ?? []);
  return words.filter(word => word.length >= 2 && word.length <= 32 &&
    /^(?:\p{Script=Han}+|[a-z][a-z0-9]*)$/iu.test(word) && !/^(.)\1+$/u.test(word) &&
    !stopWords.has(word.toLowerCase()));
}

export function analyzeVideoComments(comments: readonly PlatformComment[]): VideoCommentInsights {
  const frequencies = new Map<string, Mention>();
  const result: VideoCommentInsights = { topics: [], questionRanks: [], topLikedRanks: [], textCount: 0 };
  const segmenter = typeof Intl.Segmenter === "function" && Intl.Segmenter.supportedLocalesOf("zh").length
    ? new Intl.Segmenter("zh", { granularity: "word" }) : undefined;
  let mostLikes = 0;
  for (const [index, comment] of comments.entries()) {
    const rank = index + 1;
    const likes = comment.like_count;
    if (likes !== null && likes > 0 && likes >= mostLikes) {
      if (likes > mostLikes) result.topLikedRanks = [];
      result.topLikedRanks.push(rank);
      mostLikes = likes;
    }
    const text = readableText(comment.text);
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    result.textCount++;
    if (hasQuestion(text)) result.questionRanks.push(rank);
    for (const term of termsIn(text, segmenter)) {
      const key = term.toLowerCase();
      const entry = frequencies.get(key);
      if (!entry) frequencies.set(key, { term, ranks: [rank] });
      else if (entry.ranks[entry.ranks.length - 1] !== rank) entry.ranks.push(rank);
    }
  }
  const repeated = [...frequencies.values()].filter(entry => entry.ranks.length >= 2)
    .sort((a, b) => b.ranks.length - a.ranks.length);
  // Avoid filling the summary with adjacent words supported by exactly the same comments.
  const rankSets = new Set<string>();
  for (const entry of repeated) {
    const evidence = entry.ranks.join(",");
    if (rankSets.has(evidence)) continue;
    result.topics.push(entry);
    rankSets.add(evidence);
    if (result.topics.length === 3) break;
  }
  return result;
}
