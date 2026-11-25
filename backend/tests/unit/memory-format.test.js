import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildMemoryContent,
  formatMemoryContext,
  parseMemorySubject,
  planMemoryActions
} from "../../src/utils/memory-format.js";

const NOW = new Date("2026-11-25T00:00:00.000Z");

function extracted(overrides = {}) {
  return {
    action: "add",
    replaces_id: null,
    subject: "user",
    memory_type: "preference",
    content: "Prefers Node.js for backend development.",
    duration: "permanent",
    expires_in_days: null,
    confidence: 0.95,
    importance: 4,
    ...overrides
  };
}

test("subject prefix round trip", () => {
  assert.equal(buildMemoryContent("user", "Likes tea."), "Likes tea.");
  assert.equal(buildMemoryContent("User's Sister", "Likes jazz."), "[about: user's sister] Likes jazz.");
  assert.deepEqual(parseMemorySubject("[about: user's sister] Likes jazz."), {
    subject: "user's sister",
    text: "Likes jazz."
  });
  assert.deepEqual(parseMemorySubject("Legacy memory"), { subject: "user", text: "Legacy memory" });
});

test("formatMemoryContext separates the user from other people", () => {
  const text = formatMemoryContext([
    { memory_type: "preference", content: "Prefers Python." },
    { memory_type: "fact", content: "[about: user's sister] Loves jazz." }
  ]);

  assert.match(text, /About the user:\n- \[preference\] Prefers Python\./);
  assert.match(text, /not facts about the user\):\n- \[fact\] \(user's sister\) Loves jazz\./);
  assert.equal(formatMemoryContext([]), "");
});

test("a clear permanent change supersedes the old preference", () => {
  const old = { id: "m1", memory_type: "preference", content: "Prefers Python for backend development." };
  const plan = planMemoryActions(
    [extracted({ action: "update", replaces_id: "m1" })],
    [old],
    [old],
    NOW
  );

  assert.equal(plan.length, 1);
  assert.equal(plan[0].type, "supersede");
  assert.equal(plan[0].replacesId, "m1");
});

test("updates are refused for unknown ids, other subjects, temporary items or low confidence", () => {
  const old = { id: "m1", memory_type: "preference", content: "Prefers Python." };
  const cases = [
    extracted({ action: "update", replaces_id: "unknown" }),
    extracted({ action: "update", replaces_id: "m1", subject: "user's brother", content: "Prefers Go." }),
    extracted({ action: "update", replaces_id: "m1", duration: "temporary", content: "Using Go this week." }),
    extracted({ action: "update", replaces_id: "m1", confidence: 0.5, content: "Maybe prefers Rust." }),
    extracted({ action: "update", replaces_id: "m1", memory_type: "fact", content: "Works with Go." })
  ];

  for (const item of cases) {
    const [step] = planMemoryActions([item], [old], [old], NOW);

    assert.equal(step.type, "add", JSON.stringify(item));
  }
});

test("another person's fact is stored with its subject", () => {
  const [step] = planMemoryActions(
    [extracted({ subject: "user's sister", memory_type: "fact", content: "Loves jazz." })],
    [],
    [],
    NOW
  );

  assert.equal(step.memory.content, "[about: user's sister] Loves jazz.");
});

test("temporary memories get an expiry date", () => {
  const [step] = planMemoryActions(
    [extracted({ duration: "temporary", expires_in_days: 3, memory_type: "commitment", content: "Busy this week." })],
    [],
    [],
    NOW
  );

  assert.equal(step.memory.expiresAt, "2026-11-28T00:00:00.000Z");

  const [fallback] = planMemoryActions(
    [extracted({ duration: "temporary", expires_in_days: null, content: "Travelling." })],
    [],
    [],
    NOW
  );

  assert.equal(fallback.memory.expiresAt, "2026-12-02T00:00:00.000Z");
});

test("duplicates are skipped even with different punctuation or case", () => {
  const existing = [{ id: "m1", memory_type: "preference", content: "Prefers Node.js for backend development" }];
  const [step] = planMemoryActions(
    [extracted({ content: "prefers node js for backend development!" })],
    existing,
    existing,
    NOW
  );

  assert.deepEqual(step, { type: "skip", reason: "duplicate" });
});

test("invalid items and 'none' actions are ignored", () => {
  const plan = planMemoryActions(
    [extracted({ action: "none" }), extracted({ memory_type: "secret" }), extracted({ importance: 9 })],
    [],
    [],
    NOW
  );

  assert.deepEqual(plan.map((step) => step.type), ["skip", "skip"]);
});

test("one old memory cannot be superseded twice", () => {
  const old = { id: "m1", memory_type: "preference", content: "Prefers Python." };
  const plan = planMemoryActions(
    [
      extracted({ action: "update", replaces_id: "m1", content: "Prefers Node.js." }),
      extracted({ action: "update", replaces_id: "m1", content: "Prefers Go." })
    ],
    [old],
    [old],
    NOW
  );

  assert.deepEqual(plan.map((step) => step.type), ["supersede", "add"]);
});
