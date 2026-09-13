import assert from "node:assert/strict";
import { runtimeFixture } from "./runtime-fixture.mjs";
import * as production from "../../lib/content-production.ts";
import * as publishedCopy from "../../lib/published-copy.ts";
import * as recovery from "../../lib/content-citation-recovery.ts";
import * as rewrite from "../../lib/single-benchmark-rewrite.ts";

// User-supplied reference and the accepted ChatGPT-topic mapping serve as the regression example.
export const reference = [
  '大一大二想跟老师做项目，千万别只发一句：“老师，你有项目吗？”',
  '老师更想知道的，不是你有多想学，而是你现在能做什么。',
  '我当时能被老师记住，是因为先把 Python 实训项目和结课答辩认真做好了。',
  '所以找老师之前，先准备三样东西：一个能现场演示的课程项目，一句话说清自己负责了什么，以及每周能投入多少时间。',
  '然后可以这样问：“老师您好，我在您的 Python 课上做了一个 XX 项目，主要负责 XX，目前每周能投入 XX 小时。如果你有合适的项目，我想从测试、数据整理或者基础开发做起。”',
  '你不需要一开始就很厉害，但要让老师知道它可以怎么用你。',
  '下一条我再讲怎么把普通课程作业改成能写进简历的项目。',
];
export const generated = [
  '刚开始用 ChatGPT，千万别只发一句：“帮我写个自我介绍。”',
  '它最需要知道的，不是你有多着急，而是这段介绍要用在哪里。',
  '同样是自我介绍，用来参加社团和投实习，需要突出的内容就不一样。',
  '所以提问之前，先准备三样东西：你现在的身份和经历，这次介绍要达到什么目的，以及字数和语气有什么要求。',
  '然后可以这样问：“我是计算机专业大二学生，做过一个 Python 课程项目，主要负责数据处理。现在准备第一次实习面试，请帮我写一段两百字以内的自我介绍，口语一点，不要编造我没做过的经历。”',
  '你不需要一开始就会写复杂的提示词，但要让它知道这次该怎么帮你。',
  '下一条我再讲怎么把 AI 写出来的模板话，改成你在面试时能自然说出口的自我介绍。',
];
const roles = ['错误开口钩子', '真正所需信息', '具体例子', '三项准备', '示范话术', '降低门槛', '下一条预告'];
export const plan = { hookTechnique: '用错误提问提醒观众', ctaTechnique: '下一条内容预告', segments: reference.map((sourceText, index) => ({ sourceText, role: roles[index], transition: index ? '承接上段的问题继续展开' : '直接开场', adaptation: `围绕新选题完成${roles[index]}，经历改为明确例子` })) };
export const source = { sourceId: 'benchmark', sourceTitle: '找老师做项目', sourceScript: reference.join(''), sourceKind: 'corrected_original' };
export const segments = generated.map((text, index) => ({ index: index + 1, text, application: `保留${roles[index]}，将内容换成向 ChatGPT 交代任务` }));

export async function fixture(t, options = {}) {
  const f = runtimeFixture(t), installation = await f.initialize(); f.identity.userId = installation.userId;
  const organizationId = installation.organizationId, projectId = 'project', now = '2026-09-13T00:00:00.000Z';
  const seed = (table, values) => {
    const columns = new Set(f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const row = Object.fromEntries(Object.entries({ id: crypto.randomUUID(), organization_id: organizationId, project_id: projectId, created_by: installation.userId, updated_by: installation.userId, created_at: now, updated_at: now, ...values }).filter(([key]) => columns.has(key)));
    f.sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row)); return row.id;
  };
  seed('projects', { id: projectId, name: 'Project', client_name: 'Account' });
  seed('projects', { id: 'other', name: 'Other', client_name: 'Other' });
  seed('content_strategies', { id: 'strategy', version: 1, name: '内容策略', status: 'active', positioning: '内容策略继续指导创作方向与表达方式', target_audience: '大学生与初学者', style_notes: '口语化，避免夸大效果', pain_points_json: '[]', pillars_json: '[]', topic_mix_json: '{}', objectives_json: '["教育"]' });
  const topicId = seed('topic_ideas', { title: '怎么使用 ChatGPT', source_type: 'manual' });
  const contentId = seed('content_items', { topic_id: topicId, title: '怎么使用 ChatGPT' });
  const base = production.createProductionScaffold({ id: topicId, title: '怎么使用 ChatGPT' });
  seed('content_versions', { content_item_id: contentId, version: 1, generation_mode: 'scaffold', pack_json: JSON.stringify(base), full_script: base.fullScript, short_script: base.shortScript });
  seed('videos', { id: 'video', platform: 'douyin', source_type: 'url', title: source.sourceTitle });
  seed('video_library_entries', { id: 'benchmark', source_video_id: 'video' });
  const report = options.noScript || options.transcript ? { summary: '只有分析摘要不能作为完整口播模板' } : { spoken_script_set: { corrected_original: { status: 'completed', text: source.sourceScript, validation: { passed: true } } } };
  seed('video_analyses', { video_id: 'video', schema_version: '1', report_json: JSON.stringify(report) });
  seed('project_video_references', { library_entry_id: 'benchmark', purpose: 'benchmark', status: options.revoked ? 'revoked' : 'active', project_id: options.foreign ? 'other' : projectId });
  if (options.transcript) seed('video_transcripts', { video_id: 'video', version: 1, source: 'asr', full_text: source.sourceScript, segments_json: '[]' });
  f.runtime.getProjectAccess = async (_subject, org, project) => org === organizationId && project === projectId ? { organizationRole: 'member', projectRole: 'member' } : null;
  f.runtime.canWriteProjectAccess = Boolean;
  f.mock('lib/generation-freeze.mjs.ts', { isGenerationFrozen: () => false });
  f.mock('lib/content-production.ts', production);
  f.mock('lib/published-copy.ts', publishedCopy);
  f.mock('lib/content-citation-recovery.ts', recovery);
  f.mock('lib/operations.ts', { checkOrganizationQuota: async () => ({ allowed: true }) });
  f.mock('lib/generation-context-sources.ts', { retrieveGenerationMethodologySources: async () => [] });
  const calls = []; let generations = 0, reviews = 0;
  f.mock('lib/model-adapter.ts', {
    ModelConfigurationError: class extends Error {}, ModelRequestError: class extends Error { constructor(message, code) { super(message); this.code = code; } },
    readContentModelConfig: () => ({ provider: 'fixture', model: 'fixture' }),
    invokeContentModel: async input => {
      calls.push(input); if (options.invoke) return options.invoke(input); let output;
      if (input.system === rewrite.BENCHMARK_PLAN_SYSTEM) output = options.invalidPlan ? { ...plan, segments: plan.segments.slice(1) } : plan;
      else if (input.system === rewrite.BENCHMARK_REVIEW_SYSTEM) {
        reviews++;
        output = options.rejectReview && (options.rejectReview === 'always' || reviews === 1) ? { passed: false, issues: ['末段改成了评论 CTA，需要保留下一条预告。'] } : { passed: true, issues: [] };
      } else {
        generations++;
        const prompt = production.parseModelJson(input.user);
        assert.equal(prompt.materialSelection.creationMode, 'single_benchmark');
        assert.deepEqual(prompt.singleBenchmarkTemplate.plan, plan);
        assert.match(input.system, /模板.*通用方法|单条模板/);
        if (generations > 1 && (options.shortFirst || options.rejectReview || options.longDrafts)) {
          assert.ok(prompt.rewriteRevision?.previousDraft?.fullScript);
          assert.equal(prompt.rewriteRevision.budget.targetCharacters, 284);
          assert.equal(prompt.rewriteRevision.segmentChanges.length, plan.segments.length);
          assert.equal(input.temperature, 0.2);
        }
        let outputSegments = options.shortFirst && generations === 1 ? segments.map(s => ({ ...s, text: '过短' })) : segments;
        if (options.longDrafts && generations <= options.longDrafts) {
          const extra = '补'.repeat(393 - rewrite.rewriteCharacterCount(generated.join('')));
          outputSegments = segments.map((s, index) => index === 4 ? { ...s, text: s.text + extra } : s);
        }
        output = { ...base, fullScript: outputSegments.map(s => s.text).join('\n\n'), benchmarkRewriteSegments: outputSegments,
          qualityReview: { ...base.qualityReview, benchmarkMethods: [{ sourceId: 'benchmark', method: '逐段同构', application: '保留错误开口、三项准备、示范话术和下一条预告' }] },
          citations: [{ sourceType: 'strategy', sourceId: 'strategy', quote: '内容策略继续指导创作方向与表达方式' }, { sourceType: 'method_knowledge', sourceId: prompt.methodologyPlan.planId, quote: '一条内容只保留一个核心主张' }, { sourceType: 'benchmark', sourceId: 'benchmark', quote: reference[0] }],
        };
      }
      return { content: JSON.stringify(output), latencyMs: 1 };
    },
  });
  const route = f.load('app/api/content-items/[contentId]/generate/route.ts');
  const scope = { organizationId, projectId };
  const params = { params: Promise.resolve({ contentId }) };
  const complete = (overrides = {}) => route.POST(new Request('http://localhost/api/content-items/test/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...scope, creationMode: 'single_benchmark', benchmarkEntryIds: ['benchmark'], ...overrides }) }), params);
  return { ...f, seed, scope, contentId, params, calls, complete, stats: () => ({ generations, reviews }) };
}
