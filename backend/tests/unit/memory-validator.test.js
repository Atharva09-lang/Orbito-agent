import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";

import pool from "../../src/config/database.js";
import {
  createMemoryController,
  updateMemoryController
} from "../../src/controllers/memory.controller.js";
import { validate } from "../../src/middleware/validate.middleware.js";
import {
  createMemorySchema,
  memoryParamsSchema,
  updateMemorySchema
} from "../../src/validators/memory.validator.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const MEMORY_ID = "22222222-2222-4222-8222-222222222222";

async function startServer(t, method, schema, controller) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: USER_ID };
    next();
  });

  if (method === "POST") {
    app.post("/memories", validate(schema), controller);
  } else {
    app.patch(
      "/memories/:id",
      validate(memoryParamsSchema, "params"),
      validate(schema),
      controller
    );
  }

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  return `http://127.0.0.1:${server.address().port}/memories`;
}

async function request(url, method, body, id = MEMORY_ID) {
  const response = await fetch(method === "POST" ? url : `${url}/${id}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  return { status: response.status, body: await response.json() };
}

function mockCreate(t) {
  let connects = 0;
  const client = {
    async query(text, params = []) {
      const normalized = text.replace(/\s+/g, " ").trim();

      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
        return { rows: [] };
      }
      if (normalized.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      if (normalized.startsWith("SELECT 1") && normalized.includes("FROM messages m")) {
        return { rows: [{}] };
      }
      if (normalized.startsWith("SELECT id, memory_type, content")) {
        return { rows: [] };
      }
      if (normalized.startsWith("SELECT id, content") && normalized.includes("ORDER BY updated_at DESC")) {
        return { rows: [] };
      }
      if (normalized.startsWith("INSERT INTO memories")) {
        return {
          rows: [{
            id: MEMORY_ID,
            user_id: params[0],
            memory_type: params[1],
            content: params[2],
            confidence: params[3],
            importance: params[4],
            source_message_id: params[5],
            expires_at: params[6]
          }]
        };
      }

      throw new Error(`Unexpected query: ${text}`);
    },
    release() {}
  };

  t.mock.method(pool, "connect", async () => {
    connects += 1;
    return client;
  });

  return { get connects() { return connects; } };
}

function mockUpdate(t, existing) {
  let connects = 0;
  t.mock.method(pool, "query", async (text, params = []) => {
    const normalized = text.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("SELECT * FROM memories")) {
      return {
        rows: existing && params[0] === USER_ID && params[1] === MEMORY_ID ? [existing] : []
      };
    }

    throw new Error(`Unexpected pooled query: ${text}`);
  });

  const client = {
    async query(text, params = []) {
      const normalized = text.replace(/\s+/g, " ").trim();

      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
        return { rows: [] };
      }
      if (normalized.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      if (normalized.startsWith("SELECT id, content") && normalized.includes("ORDER BY updated_at DESC")) {
        return { rows: [] };
      }
      if (normalized.startsWith("SELECT * FROM memories")) {
        return {
          rows: existing && params[0] === USER_ID && params[1] === MEMORY_ID ? [existing] : []
        };
      }
      if (normalized.startsWith("UPDATE memories") && normalized.includes("SET content")) {
        return { rows: [{ ...existing, content: params[2] }] };
      }

      throw new Error(`Unexpected query: ${text}`);
    },
    release() {}
  };

  t.mock.method(pool, "connect", async () => {
    connects += 1;
    return client;
  });

  return { get connects() { return connects; } };
}

test("create route schema accepts valid, other-person, and omitted subjects through middleware", async (t) => {
  const url = await startServer(t, "POST", createMemorySchema, createMemoryController);
  const mock = mockCreate(t);
  const scenarios = [
    [{ memoryType: "fact", subject: "user", content: "I prefer Java." }, "I prefer Java."],
    [{ memoryType: "fact", subject: "Rahul", content: "Prefers Java." }, "[about: rahul] Prefers Java."],
    [{ memoryType: "fact", content: "Likes tea." }, "Likes tea."]
  ];

  for (const [body, expectedContent] of scenarios) {
    const result = await request(url, "POST", body);
    assert.equal(result.status, 201);
    assert.equal(result.body.success, true);
    assert.equal(result.body.memory.content, expectedContent);
  }

  assert.equal(mock.connects, 3);
});

test("create route schema rejects malformed, conflicting, and unrelated fields before persistence", async (t) => {
  const url = await startServer(t, "POST", createMemorySchema, createMemoryController);
  const mock = mockCreate(t);
  const scenarios = [
    { memoryType: "fact", subject: "", content: "Likes tea." },
    { memoryType: "fact", subject: "   ", content: "Likes tea." },
    { memoryType: "fact", subject: "[about: Rahul]", content: "Likes tea." },
    { memoryType: "fact", subject: "Rahul!", content: "Likes tea." },
    { memoryType: "fact", subject: "Rahul..", content: "Likes tea." },
    { memoryType: "fact", subject: 42, content: "Likes tea." },
    { memoryType: "fact", subject: "Rahul", content: "Currently I prefer Java." },
    { memoryType: "fact", subject: "user", content: "He prefers Java." },
    { memoryType: "fact", subject: "user", content: "Likes tea.", admin: true }
  ];

  for (const body of scenarios) {
    const result = await request(url, "POST", body);
    assert.equal(result.status, 400);
    assert.equal(result.body.success, false);
  }

  assert.equal(mock.connects, 0);
});

test("update route schema accepts matching user, other-person, and omitted subjects", async (t) => {
  const scenarios = [
    {
      name: "user subject",
      existing: { id: MEMORY_ID, user_id: USER_ID, memory_type: "fact", content: "Likes tea.", is_active: true },
      body: { content: "Enjoys tea.", subject: "user" },
      expected: "Enjoys tea."
    },
    {
      name: "other-person subject",
      existing: { id: MEMORY_ID, user_id: USER_ID, memory_type: "fact", content: "[about: rahul] Likes jazz.", is_active: true },
      body: { content: "Enjoys jazz.", subject: "friend Rahul" },
      expected: "[about: rahul] Enjoys jazz."
    },
    {
      name: "omitted subject",
      existing: { id: MEMORY_ID, user_id: USER_ID, memory_type: "fact", content: "Likes tea.", is_active: true },
      body: { content: "Enjoys tea." },
      expected: "Enjoys tea."
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const url = await startServer(t, "PATCH", updateMemorySchema, updateMemoryController);
      const mock = mockUpdate(t, scenario.existing);
      const result = await request(url, "PATCH", scenario.body);

      assert.equal(result.status, 200);
      assert.equal(result.body.success, true);
      assert.equal(result.body.memory.content, scenario.expected);
      assert.equal(mock.connects, 1);
    });
  }
});

test("update route schema rejects malformed or conflicting subjects without changing ownership", async (t) => {
  const scenarios = [
    {
      name: "empty subject",
      existing: { id: MEMORY_ID, user_id: USER_ID, memory_type: "fact", content: "Likes tea.", is_active: true },
      body: { content: "Enjoys tea.", subject: "" },
      status: 400,
      connects: 0
    },
    {
      name: "malformed subject",
      existing: { id: MEMORY_ID, user_id: USER_ID, memory_type: "fact", content: "Likes tea.", is_active: true },
      body: { content: "Enjoys tea.", subject: "Rahul!" },
      status: 400,
      connects: 0
    },
    {
      name: "conflicting first-person subject",
      existing: { id: MEMORY_ID, user_id: USER_ID, memory_type: "fact", content: "Likes tea.", is_active: true },
      body: { content: "Currently I prefer tea.", subject: "Rahul" },
      status: 400,
      connects: 0
    },
    {
      name: "other-person memory cannot become a user memory",
      existing: { id: MEMORY_ID, user_id: USER_ID, memory_type: "fact", content: "[about: rahul] Likes jazz.", is_active: true },
      body: { content: "Enjoys jazz.", subject: "user" },
      status: 400,
      connects: 0
    },
    {
      name: "cross-user update",
      existing: null,
      body: { content: "Enjoys tea.", subject: "user" },
      status: 404,
      connects: 0
    },
    {
      name: "unrelated field",
      existing: { id: MEMORY_ID, user_id: USER_ID, memory_type: "fact", content: "Likes tea.", is_active: true },
      body: { content: "Enjoys tea.", subject: "user", admin: true },
      status: 400,
      connects: 0
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const url = await startServer(t, "PATCH", updateMemorySchema, updateMemoryController);
      const mock = mockUpdate(t, scenario.existing);
      const result = await request(url, "PATCH", scenario.body);

      assert.equal(result.status, scenario.status);
      assert.equal(result.body.success, false);
      assert.equal(mock.connects, scenario.connects);
    });
  }
});
