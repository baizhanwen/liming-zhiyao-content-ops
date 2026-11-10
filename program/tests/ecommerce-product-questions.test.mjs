import assert from "node:assert/strict";
import test from "node:test";
import { productAnswerSelection, productAnswerTransition, productQuestionOptions } from "../lib/ecommerce/product-question-options.ts";

test("a saved specific answer remains a free-text answer without normalization or loss", () => {
  const original = "给经常夜班、需要随身携带餐盒的护理人员";
  assert.equal(productAnswerSelection(original, productQuestionOptions.user), "__custom__");
  assert.equal(productAnswerTransition(original, "", "__custom__", productQuestionOptions.user).value, original);
});

test("switching from a custom answer to a suggestion and back restores the previous custom text", () => {
  const original = "机场转机时临时办公，需要快速收纳";
  const suggestion = productAnswerTransition(original, "", "外出与旅行", productQuestionOptions.scene);
  assert.equal(suggestion.value, "外出与旅行");
  const restored = productAnswerTransition(suggestion.value, suggestion.custom, "__custom__", productQuestionOptions.scene);
  assert.equal(restored.value, original);
  assert.equal(restored.editingCustom, true);
});

test("no suggested answer or confirmation is silently selected for an empty field", () => {
  assert.equal(productAnswerSelection("", productQuestionOptions.category), "");
  const custom = productAnswerTransition("", "", "__custom__", productQuestionOptions.category);
  assert.equal(custom.value, "");
  assert.equal(custom.editingCustom, true);
  assert.equal(productAnswerTransition("", "", "unknown-option", productQuestionOptions.category).value, "");
});
