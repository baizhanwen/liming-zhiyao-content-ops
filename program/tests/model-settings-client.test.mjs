import assert from "node:assert/strict";
import test from "node:test";
import { modelConfigurationDraft, modelConfigurationUpdate } from "../lib/model-settings-client.ts";

const saved = {
  provider: "glm", baseUrl: "https://api.example.invalid/v1", model: "model-before",
  apiKeyConfigured: true, updatedAt: null,
};

test("editing a saved model never needs or resubmits its secret", () => {
  const draft = modelConfigurationDraft(saved);
  assert.equal(draft.apiKey, "");
  draft.model = "model-after";
  assert.deepEqual(modelConfigurationUpdate(draft, saved), { provider: "glm", baseUrl: saved.baseUrl, model: "model-after" });
  assert.equal(saved.model, "model-before");
});

test("changing the provider or endpoint cannot silently reuse another service's saved key", () => {
  for (const change of [{ provider: "another-provider" }, { baseUrl: "https://another.example.invalid/v1" }]) {
    const draft = { ...modelConfigurationDraft(saved), ...change };
    assert.throws(() => modelConfigurationUpdate(draft, saved), /填写对应的新密钥/);
    draft.apiKey = "new-key-fixture";
    assert.equal(modelConfigurationUpdate(draft, saved).apiKey, "new-key-fixture");
  }
});

test("explicit removal discards a typed secret and remains distinct from blank-key preservation", () => {
  const draft = { ...modelConfigurationDraft(saved), apiKey: "must-not-send-fixture", clearApiKey: true };
  assert.deepEqual(modelConfigurationUpdate(draft, saved), { provider: "glm", baseUrl: saved.baseUrl, model: saved.model, clearApiKey: true });
  assert.doesNotMatch(JSON.stringify(modelConfigurationUpdate(draft, saved)), /must-not-send-fixture/);
});

test("equivalent trailing slashes do not force a key replacement", () => {
  const draft = { ...modelConfigurationDraft(saved), baseUrl: saved.baseUrl + "/" };
  assert.doesNotThrow(() => modelConfigurationUpdate(draft, saved));
  assert.equal(modelConfigurationUpdate(draft, saved).baseUrl, saved.baseUrl);
});
