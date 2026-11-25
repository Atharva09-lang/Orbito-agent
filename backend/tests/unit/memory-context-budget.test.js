import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fitMemoryListToBudget,
  retrieveMemoryContext,
  selectMemoryContextCandidates
} from "../../src/services/agent.service.js";
import pool from "../../src/config/database.js";
import { TOKEN_BUDGETS, estimateTokens } from "../../src/services/token-budget.service.js";
import { formatMemoryContext } from "../../src/utils/memory-format.js";

test("formatted memory context includes labels and separators in its token budget", () => {
  const memory = {
    memory_type: "fact",
    content: "x".repeat(350)
  };
  const budget = estimateTokens(memory.content) + 5;
  const kept = fitMemoryListToBudget([memory], budget);
  const context = formatMemoryContext(kept);

  assert.equal(estimateTokens(memory.content) <= budget, true);
  assert.ok(estimateTokens(formatMemoryContext([memory])) > budget);
  assert.deepEqual(kept, []);
  assert.equal(context, "");
});

test("memory fitting preserves current-preference priority and skips oversized later items", () => {
  const current = {
    memory_type: "preference",
    content: "Prefers Node.js for backend development."
  };
  const oversized = {
    memory_type: "fact",
    content: `[about: ${"a".repeat(60)}] ${"detail ".repeat(100)}`
  };
  const history = {
    memory_type: "fact",
    content: "Previous preference: Prefers Python for backend development."
  };
  const otherPerson = {
    memory_type: "preference",
    content: "[about: rahul] Prefers Java for DSA."
  };
  const budget = 160;
  const kept = fitMemoryListToBudget([current, oversized, history, otherPerson], budget);
  const context = formatMemoryContext(kept);

  assert.equal(kept[0], current);
  assert.equal(kept.includes(oversized), false);
  assert.ok(estimateTokens(context) <= budget);
  assert.match(context, /Prefers Node\.js for backend development\./);
});

test("the default memory budget is enforced on the final assembled context", () => {
  const memories = Array.from({ length: 8 }, (_, index) => ({
    memory_type: index === 0 ? "preference" : "fact",
    content: index === 0
      ? "Prefers Node.js for backend development."
      : `[about: person-${index}] ${"Saved detail ".repeat(30)}`
  }));
  const kept = fitMemoryListToBudget(memories);
  const context = formatMemoryContext(kept);

  assert.ok(estimateTokens(context) <= TOKEN_BUDGETS.memories);
  assert.equal(kept[0], memories[0]);
});

test("retrieval filters ambiguous rows before selecting from the bounded larger candidate set", async (t) => {
  const ambiguous = Array.from({ length: 30 }, (_, index) => ({
    id: `ambiguous-${index}`,
    memory_type: "preference",
    content: "He prefers Python for backend development.",
    match_count: 1,
    importance: 5,
    confidence: 1,
    source_message_id: null
  }));
  const valid = {
    id: "valid-node",
    memory_type: "preference",
    content: "Prefers Node.js for backend development.",
    match_count: 1,
    importance: 3,
    confidence: 0.9,
    source_message_id: null
  };
  const unsafeFallback = {
    id: "unsafe-fallback",
    memory_type: "fact",
    content: "Them and their team use Python.",
    match_count: 0,
    importance: 5,
    confidence: 1,
    source_message_id: null
  };
  const calls = [];
  t.mock.method(pool, "query", async (text, params = []) => {
    calls.push({ text, params });
    return { rows: [...ambiguous, valid, unsafeFallback] };
  });
  t.mock.method(console, "log", () => {});

  const context = await retrieveMemoryContext("user-a", "backend");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[2], 100);
  assert.match(context, /Prefers Node\.js for backend development\./);
  assert.doesNotMatch(context, /He prefers|Them and their team/);
});

test("retrieval excludes inferred legacy named-person rows before selection and fallback", async (t) => {
  const legacyNamed = Array.from({ length: 30 }, (_, index) => ({
    id: `legacy-named-${index}`,
    memory_type: "preference",
    content: "Rahul prefers Python for backend development.",
    match_count: 1,
    importance: 5,
    confidence: 1,
    source_message_id: null
  }));
  const valid = {
    id: "valid-node",
    memory_type: "preference",
    content: "Prefers Node.js for backend development.",
    match_count: 1,
    importance: 3,
    confidence: 0.9,
    source_message_id: null
  };
  const unsafeFallback = {
    id: "unsafe-named-fallback",
    memory_type: "fact",
    content: "Chris uses Java for backend development.",
    match_count: 0,
    importance: 5,
    confidence: 1,
    source_message_id: null
  };
  const calls = [];
  t.mock.method(pool, "query", async (text, params = []) => {
    calls.push({ text, params });
    return { rows: [...legacyNamed, valid, unsafeFallback] };
  });
  t.mock.method(console, "log", () => {});

  const context = await retrieveMemoryContext("user-a", "backend");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[2], 100);
  assert.match(context, /Prefers Node\.js for backend development\./);
  assert.doesNotMatch(context, /Rahul|Chris/);
});

test("current user preferences rank ahead of matched history and other memories", () => {
  const history = {
    memory_type: "fact",
    content: "Previous preference: Prefers Python for backend development.",
    match_count: 3,
    importance: 5
  };
  const other = {
    memory_type: "fact",
    content: "[about: rahul] Prefers Java for backend development.",
    match_count: 2,
    importance: 5
  };
  const current = {
    memory_type: "preference",
    content: "Prefers Node.js for backend development.",
    match_count: 1,
    importance: 3
  };
  const selected = selectMemoryContextCandidates([history, other, current]);

  assert.deepEqual(selected, [current, other, history]);
  assert.equal(selected.length <= 8, true);
});
