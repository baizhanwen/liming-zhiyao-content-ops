import assert from "node:assert/strict";
import test from "node:test";

test("enterprise-space membership is binary", async () => {
  const { organizationRoles, projectRoles } = await import("../lib/authorization.ts");
  assert.deepEqual([...organizationRoles], ["admin", "member"]);
  assert.deepEqual([...projectRoles], ["member"]);
});
test('explicit model allowlists reject unsupported provider or model', async () => {
  const { modelPolicyError } = await import('../lib/model-policy.ts');
  assert.equal(modelPolicyError({ provider: 'deepseek', model: 'deepseek-chat' }), null);
  assert.match(modelPolicyError({ provider: 'deepseek', model: 'deepseek-chat', allowedProviders: 'openai-compatible' }) ?? '', /提供方/);
  assert.match(modelPolicyError({ provider: 'deepseek', model: 'deepseek-chat', allowedModels: 'deepseek-reasoner' }) ?? '', /模型/);
  assert.equal(modelPolicyError({ provider: 'deepseek', model: 'deepseek-chat', allowedProviders: ' DeepSeek ', allowedModels: 'deepseek-chat' }), null);
});
