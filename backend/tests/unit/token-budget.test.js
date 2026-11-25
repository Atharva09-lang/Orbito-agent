import { test } from "node:test";
import assert from "node:assert/strict";

import {
  estimateMessagesTokens,
  estimateTokens,
  fitListToBudget,
  trimMessagesToBudget,
  truncateToTokens
} from "../../src/services/token-budget.service.js";

test("estimateTokens handles strings, objects and empty values", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens("a".repeat(35)), 10);
  assert.ok(estimateTokens({ a: "b" }) > 0);
});

test("estimateMessagesTokens includes tools and per-message overhead", () => {
  const messages = [{ role: "user", content: "a".repeat(35) }];
  const withoutTools = estimateMessagesTokens(messages);
  const withTools = estimateMessagesTokens(messages, [{ type: "function", function: { name: "x" } }]);

  assert.equal(withoutTools, 14);
  assert.ok(withTools > withoutTools);
});

test("trimMessagesToBudget keeps the newest messages and reports dropped ones", () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `${index}`.repeat(70)
  }));

  const { kept, dropped, usedTokens } = trimMessagesToBudget(messages, 80);

  assert.equal(kept.at(-1), messages.at(-1));
  assert.ok(usedTokens <= 80);
  assert.equal(kept.length + dropped.length, messages.length);
  assert.deepEqual(dropped, messages.slice(0, dropped.length));
});

test("trimMessagesToBudget always keeps the latest message even when it is too large", () => {
  const messages = [{ role: "user", content: "x".repeat(10000) }];
  const { kept } = trimMessagesToBudget(messages, 10);

  assert.equal(kept.length, 1);
});

test("fitListToBudget keeps order and skips items that do not fit", () => {
  const items = ["a".repeat(35), "b".repeat(350), "c".repeat(35)];
  const { kept, usedTokens } = fitListToBudget(items, 25, (item) => item);

  assert.deepEqual(kept, [items[0], items[2]]);
  assert.equal(usedTokens, 20);
});

test("truncateToTokens shortens long text and keeps short text", () => {
  assert.equal(truncateToTokens("short", 10), "short");

  const result = truncateToTokens("x".repeat(1000), 10);

  assert.ok(result.length <= 35);
  assert.ok(result.endsWith("..."));
});
