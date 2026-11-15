import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const filename = new URL("../components/AnalysisWorkspace.tsx", import.meta.url);
const source = ts.createSourceFile(filename.pathname, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let submitUrl;
function findSubmission(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "submitUrl") submitUrl = node;
  ts.forEachChild(node, findSubmission);
}
findSubmission(source);
assert.ok(submitUrl, "The URL form must have its own submission handler");
const submission = ts.transpileModule(submitUrl.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function urlForm(enabled, ok = true) {
  const requests = [], resets = [], reviewSelections = [], submitting = [], errors = [];
  const bindings = {
    organizationId: "test-company", projectId: "test-project", analysisProfile: "standard",
    transcriptReviewEnabled: enabled,
    setSubmitting: value => submitting.push(value), setError: value => errors.push(value), setSubmitMessage() {},
    setTranscriptReviewEnabled: value => reviewSelections.push(value),
    taskReader: { current: { reader: { invalidate() {} } } },
    FormData: class { get(name) { return name === "url" ? "https://v.douyin.com/synthetic/" : "合成测试备注"; } },
    scopedFetch: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return Response.json(ok ? { video: { id: "video" }, job: { id: "job" } } : { error: { message: "暂时无法提交" } }, { status: ok ? 201 : 503 });
    },
    readError: async response => (await response.json()).error.message,
    appendCreated() {}, loadVideos: async () => {},
  };
  const submit = new Function(...Object.keys(bindings), `${submission}\nreturn submitUrl;`)(...Object.values(bindings));
  return { submit: () => submit({ preventDefault() {}, currentTarget: { reset: () => resets.push(true) } }), requests, resets, reviewSelections, submitting, errors };
}

for (const enabled of [false, true]) test(`URL submission explicitly sends transcriptReviewEnabled=${enabled}`, async () => {
  const form = urlForm(enabled);
  await form.submit();
  assert.equal(form.requests.length, 1);
  assert.equal(form.requests[0].url, "/api/videos/from-url");
  assert.equal(form.requests[0].body.transcriptReviewEnabled, enabled);
  assert.equal(typeof form.requests[0].body.transcriptReviewEnabled, "boolean");
  assert.equal(form.requests[0].body.title, "合成测试备注");
  assert.deepEqual(form.reviewSelections, [false], "A new submission starts with correction candidates off");
  assert.deepEqual(form.resets, [true]);
  assert.deepEqual(form.submitting, [true, false]);
});

test("rejected URL submission preserves the user's correction choice for retry", async () => {
  const form = urlForm(true, false);
  await form.submit();
  assert.deepEqual(form.reviewSelections, []);
  assert.deepEqual(form.resets, []);
  assert.deepEqual(form.errors, ["", "暂时无法提交"]);
  assert.deepEqual(form.submitting, [true, false]);
});
