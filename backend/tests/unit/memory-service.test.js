import { test } from "node:test";
import assert from "node:assert/strict";

import pool from "../../src/config/database.js";
import { extractAndSaveMemories } from "../../src/services/memory.service.js";

function extractedFact(content) {
  return {
    action: "add",
    replaces_id: null,
    subject: "user",
    memory_type: "fact",
    content,
    duration: "permanent",
    expires_in_days: null,
    confidence: 0.99,
    importance: 3
  };
}

function mockExtraction(t, options = {}) {
  const memories = options.memories ?? [];
  const store = (options.existing ?? []).map((memory) => ({ ...memory }));
  const calls = [];
  const errors = [];
  const fetchCalls = [];
  let snapshot = [];
  let releaseCount = 0;
  let connectCount = 0;
  let insertAttempts = 0;
  const client = {
    calls,
    get releaseCount() {
      return releaseCount;
    },
    async query(text, params = []) {
      const normalized = text.replace(/\s+/g, " ").trim();
      calls.push({ text: normalized, params });

      if (normalized === "BEGIN") {
        snapshot = store.map((memory) => ({ ...memory }));
        return { rows: [] };
      }

      if (normalized === "COMMIT") {
        return { rows: [] };
      }

      if (normalized === "ROLLBACK") {
        store.splice(0, store.length, ...snapshot.map((memory) => ({ ...memory })));
        return { rows: [] };
      }

      if (normalized.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }

      if (normalized.startsWith("SELECT 1") && normalized.includes("FROM messages m")) {
        return { rows: [{}] };
      }

      if (normalized.startsWith("SELECT id, content")) {
        return { rows: [] };
      }

      if (normalized.startsWith("INSERT INTO memories")) {
        insertAttempts++;

        if (insertAttempts === options.failInsertAt) {
          throw new Error("simulated extraction insert failure");
        }

        const row = {
          id: `memory-${insertAttempts}`,
          user_id: params[0],
          memory_type: params[1],
          content: params[2],
          confidence: params[3],
          importance: params[4],
          source_message_id: params[5],
          expires_at: params[6],
          is_active: true
        };
        store.push(row);
        return { rows: [row] };
      }

      throw new Error(`Unexpected query: ${text}`);
    },
    release() {
      releaseCount++;
    }
  };

  t.mock.method(pool, "connect", async () => {
    connectCount++;
    return client;
  });
  t.mock.method(pool, "query", async (text) => {
    const normalized = text.replace(/\s+/g, " ").trim();

    if (normalized.includes("AS match_count") || normalized.startsWith("SELECT * FROM memories")) {
      return { rows: store.filter((memory) => memory.is_active) };
    }

    throw new Error(`Unexpected pooled query: ${text}`);
  });
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", (...args) => {
    errors.push(args.join(" "));
  });

  return {
    memories,
    store,
    client,
    errors,
    fetchCalls,
    get connectCount() {
      return connectCount;
    }
  };
}

function transactionCommands(client) {
  return client.calls
    .map((call) => call.text)
    .filter((text) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(text));
}

test("memory extraction transaction behavior", async (t) => {
  let activeHarness;
  const previousApiKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "unit-test-key";
  t.after(() => {
    if (previousApiKey === undefined) {
      delete process.env.GROQ_API_KEY;
    } else {
      process.env.GROQ_API_KEY = previousApiKey;
    }
  });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(activeHarness.connectCount, 0);
    assert.equal(activeHarness.client.calls.length, 0);
    activeHarness.fetchCalls.push({ url, init });

    return new Response(JSON.stringify({
      id: "extraction-completion",
      object: "chat.completion",
      created: 1,
      model: "test-model",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: JSON.stringify({ memories: activeHarness.memories })
        },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 10,
        total_tokens: 20
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });

  await t.test("waits for the LLM before committing all operations together", async (t) => {
    activeHarness = mockExtraction(t, {
      memories: [
        extractedFact("First fact."),
        extractedFact("Second fact."),
        extractedFact("Third fact.")
      ]
    });

    const saved = await extractAndSaveMemories("user-a", "Remember these facts.", "source-id");

    assert.equal(saved.length, 3);
    assert.equal(activeHarness.fetchCalls.length, 1);
    assert.equal(activeHarness.connectCount, 1);
    assert.equal(activeHarness.store.length, 3);
    assert.deepEqual(transactionCommands(activeHarness.client), ["BEGIN", "COMMIT"]);
    assert.equal(activeHarness.client.releaseCount, 1);
    assert.deepEqual(activeHarness.errors, []);
  });

  await t.test("rolls back a failed plan and remains best-effort for message processing", async (t) => {
    const preserved = {
      id: "preserved",
      user_id: "user-a",
      memory_type: "fact",
      content: "Preserved fact.",
      is_active: true
    };
    activeHarness = mockExtraction(t, {
      existing: [preserved],
      failInsertAt: 3,
      memories: [
        extractedFact("First fact."),
        extractedFact("Second fact."),
        extractedFact("Third fact.")
      ]
    });

    const saved = await extractAndSaveMemories("user-a", "Remember these facts.", "source-id");

    assert.deepEqual(saved, []);
    assert.deepEqual(activeHarness.store, [preserved]);
    assert.deepEqual(transactionCommands(activeHarness.client), ["BEGIN", "ROLLBACK"]);
    assert.equal(activeHarness.client.releaseCount, 1);
    assert.equal(activeHarness.errors.some((message) => message.includes("Memory extraction failed:")), true);
  });

  await t.test("performs no transaction or memory mutation for an empty result", async (t) => {
    activeHarness = mockExtraction(t, { memories: [] });

    const saved = await extractAndSaveMemories("user-a", "Hello.", "source-id");

    assert.deepEqual(saved, []);
    assert.equal(activeHarness.fetchCalls.length, 1);
    assert.equal(activeHarness.connectCount, 0);
    assert.deepEqual(activeHarness.client.calls, []);
    assert.equal(activeHarness.client.releaseCount, 0);
    assert.equal(activeHarness.store.length, 0);
  });
});
