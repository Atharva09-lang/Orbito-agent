import { test } from "node:test";
import assert from "node:assert/strict";

import pool from "../../src/config/database.js";
import {
  createMemoryController,
  updateMemoryController
} from "../../src/controllers/memory.controller.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const MEMORY_ID = "22222222-2222-4222-8222-222222222222";

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function createClient() {
  const calls = [];

  return {
    calls,
    async query(text, params = []) {
      const normalized = text.replace(/\s+/g, " ").trim();
      calls.push({ text: normalized, params });

      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
        return { rows: [] };
      }

      if (normalized.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }

      if (normalized.startsWith("SELECT *") && normalized.includes("regexp_replace")) {
        return { rows: [] };
      }

      if (normalized.startsWith("SELECT id, memory_type, content")) {
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
}

function mockCreate(t, client = createClient()) {
  t.mock.method(pool, "connect", async () => client);
  return client;
}

function mockUpdate(t, existing, options = {}) {
  const calls = [];
  let released = false;
  const store = existing ? [{
    ...existing,
    user_id: existing.user_id ?? USER_ID,
    is_active: existing.is_active ?? true
  }] : [];

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
    calls,
    get released() {
      return released;
    },
    async query(text, params = []) {
      const normalized = text.replace(/\s+/g, " ").trim();
      calls.push({ text: normalized, params });

      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
        return { rows: [] };
      }

      if (normalized.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }

      if (normalized.startsWith("SELECT *") && normalized.includes("regexp_replace")) {
        return { rows: options.duplicate ? [options.duplicate] : [] };
      }

      if (normalized.startsWith("SELECT * FROM memories")) {
        return { rows: store.filter((memory) => memory.user_id === params[0] && memory.id === params[1]) };
      }

      if (normalized.startsWith("SELECT id, memory_type, content")) {
        return { rows: store.filter((memory) => memory.is_active && memory.expires_at == null) };
      }

      if (normalized.startsWith("INSERT INTO memories")) {
        const row = {
          id: "history-id",
          user_id: params[0],
          memory_type: params[1],
          content: params[2]
        };
        store.push(row);
        return { rows: [row] };
      }

      if (normalized.startsWith("UPDATE memories") && normalized.includes("is_active = FALSE")) {
        const row = store.find((memory) => memory.id === params[0] && memory.is_active);

        if (!row) return { rows: [] };
        row.is_active = false;
        return { rows: [{ id: row.id }] };
      }

      if (normalized.startsWith("UPDATE memories")) {
        const row = store.find((memory) => memory.id === params[1]);

        if (!row) return { rows: [] };
        row.content = params[2];
        return { rows: [row] };
      }

      throw new Error(`Unexpected query: ${text}`);
    },
    release() {
      released = true;
    }
  };

  t.mock.method(pool, "connect", async () => client);
  return client;
}

function updateRequest(content, subject) {
  return {
    user: { id: USER_ID },
    params: { id: MEMORY_ID },
    body: { content, ...(subject === undefined ? {} : { subject }) }
  };
}

test("manual create keeps safe user wording backward-compatible", async (t) => {
  const client = mockCreate(t);
  const res = createResponse();

  await createMemoryController({
    user: { id: USER_ID },
    body: {
      memoryType: "preference",
      content: "Prefers Node.js for backend development.",
      confidence: 0.95,
      importance: 4
    }
  }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.memory.content, "Prefers Node.js for backend development.");
  assert.equal(client.calls.some((call) => call.text.startsWith("INSERT INTO memories")), true);
});

test("manual create normalizes an explicit other-person subject", async (t) => {
  const client = mockCreate(t);
  const res = createResponse();

  await createMemoryController({
    user: { id: USER_ID },
    body: {
      memoryType: "preference",
      subject: "Rahul",
      content: "Prefers Java for DSA."
    }
  }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.memory.content, "[about: rahul] Prefers Java for DSA.");
  assert.equal(client.calls.find((call) => call.text.startsWith("INSERT INTO memories")).params[2],
    "[about: rahul] Prefers Java for DSA.");
});

test("manual create rejects ambiguous or conflicting attribution", async (t) => {
  const client = mockCreate(t);
  const scenarios = [
    {
      content: "Rahul prefers Java for DSA."
    },
    {
      subject: "user",
      content: "[about: rahul] Prefers Java for DSA."
    },
    {
      subject: 42,
      content: "Prefers Java for DSA."
    }
  ];

  for (const scenario of scenarios) {
    const res = createResponse();

    await createMemoryController({
      user: { id: USER_ID },
      body: {
        memoryType: "preference",
        ...scenario
      }
    }, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
  }

  assert.equal(client.calls.length, 0);
});

test("manual update preserves an other-person subject", async (t) => {
  const existing = {
    id: MEMORY_ID,
    user_id: USER_ID,
    memory_type: "preference",
    content: "[about: rahul] Prefers Java for DSA.",
    expires_at: null
  };
  const client = mockUpdate(t, existing);
  const res = createResponse();

  await updateMemoryController(updateRequest("Prefers Python for DSA."), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.memory.content, "[about: rahul] Prefers Python for DSA.");
  const update = client.calls.find((call) =>
    call.text.startsWith("UPDATE memories") && call.text.includes("SET content")
  );
  assert.deepEqual(update.params, [USER_ID, MEMORY_ID, "[about: rahul] Prefers Python for DSA."]);
  assert.equal(client.released, true);
});

test("manual update cannot change another person's memory into a user memory", async (t) => {
  const calls = [];
  t.mock.method(pool, "query", async (text) => {
    calls.push(text.replace(/\s+/g, " ").trim());
    return {
      rows: [{
        id: MEMORY_ID,
        user_id: USER_ID,
        memory_type: "preference",
        content: "[about: rahul] Prefers Java for DSA."
      }]
    };
  });
  const res = createResponse();

  await updateMemoryController(updateRequest("Prefers Python for DSA.", "user"), res);

  assert.equal(res.statusCode, 400);
  assert.equal(calls.some((text) => text.startsWith("UPDATE memories")), false);
});

test("manual update rejects ambiguous legacy attribution", async (t) => {
  const calls = [];
  t.mock.method(pool, "query", async (text) => {
    calls.push(text.replace(/\s+/g, " ").trim());
    return {
      rows: [{
        id: MEMORY_ID,
        user_id: USER_ID,
        memory_type: "preference",
        content: "He prefers Java for DSA."
      }]
    };
  });
  const res = createResponse();

  await updateMemoryController(updateRequest("Prefers Python for DSA."), res);

  assert.equal(res.statusCode, 400);
  assert.equal(calls.some((text) => text.startsWith("UPDATE memories")), false);
});

test("manual update rejects a conflicting subject prefix", async (t) => {
  t.mock.method(pool, "query", async () => ({
    rows: [{
      id: MEMORY_ID,
      user_id: USER_ID,
      memory_type: "preference",
      content: "Prefers Java for DSA."
    }]
  }));
  const res = createResponse();

  await updateMemoryController(updateRequest("[about: rahul] Prefers Python for DSA."), res);

  assert.equal(res.statusCode, 400);
});

test("manual update returns 404 for another user's memory without updating it", async (t) => {
  const calls = [];
  t.mock.method(pool, "query", async (text, params = []) => {
    const normalized = text.replace(/\s+/g, " ").trim();
    calls.push({ text: normalized, params });
    return { rows: [] };
  });
  const res = createResponse();

  await updateMemoryController(updateRequest("Prefers Python for DSA."), res);

  assert.equal(res.statusCode, 404);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [USER_ID, MEMORY_ID]);
  assert.equal(calls[0].text.startsWith("UPDATE memories"), false);
});

test("manual update returns 409 when another active memory already has the same content", async (t) => {
  const existing = {
    id: MEMORY_ID,
    user_id: USER_ID,
    memory_type: "preference",
    content: "Prefers Java for backend development.",
    expires_at: null
  };
  const duplicate = {
    ...existing,
    id: "33333333-3333-4333-8333-333333333333",
    content: "Prefers Python for backend development."
  };
  const client = mockUpdate(t, existing, { duplicate });
  const res = createResponse();

  await updateMemoryController(updateRequest("prefers python for backend development!"), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.success, false);
  assert.equal(res.body.memory.id, duplicate.id);
  assert.equal(client.calls.some((call) =>
    call.text.startsWith("UPDATE memories") || call.text.startsWith("INSERT INTO memories")
  ), false);
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
  assert.equal(client.released, true);
});

test("manual update retries do not rewrite content or duplicate history", async (t) => {
  const existing = {
    id: MEMORY_ID,
    user_id: USER_ID,
    memory_type: "preference",
    content: "Prefers Node.js for backend development.",
    expires_at: null
  };
  const client = mockUpdate(t, existing);
  const res = createResponse();

  await updateMemoryController(updateRequest("prefers node js for backend development!"), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.memory.content, existing.content);
  assert.equal(client.calls.some((call) =>
    call.text.startsWith("UPDATE memories") || call.text.startsWith("INSERT INTO memories")
  ), false);
  assert.equal(client.calls.at(-1).text, "COMMIT");
});

test("manual user preference updates preserve the old value as history", async (t) => {
  const existing = {
    id: MEMORY_ID,
    user_id: USER_ID,
    memory_type: "preference",
    content: "Prefers Python for backend development.",
    confidence: 0.81,
    importance: 2,
    source_message_id: "old-source",
    expires_at: null
  };
  const client = mockUpdate(t, existing);
  const res = createResponse();

  await updateMemoryController(updateRequest("Prefers Node.js for backend development."), res);

  assert.equal(res.statusCode, 200);
  const history = client.calls.find((call) =>
    call.text.startsWith("INSERT INTO memories") && call.params[2].startsWith("Previous preference:")
  );
  assert.equal(history.params[2], "Previous preference: Prefers Python for backend development.");
  assert.equal(history.params[3], 0.81);
  assert.equal(history.params[4], 2);
  assert.equal(history.params[5], "old-source");
  assert.equal(client.calls.at(-1).text, "COMMIT");
  assert.equal(client.released, true);
});

test("manual update cannot revive a target deactivated by a concurrent category update", async (t) => {
  const existing = {
    id: MEMORY_ID,
    user_id: USER_ID,
    memory_type: "preference",
    content: "Prefers Python for backend development.",
    expires_at: null,
    is_active: false
  };
  const client = mockUpdate(t, existing);
  const res = createResponse();

  await updateMemoryController(updateRequest("Prefers Java for backend development."), res);

  assert.equal(res.statusCode, 404);
  assert.equal(client.calls.some((call) =>
    call.text.startsWith("UPDATE memories") || call.text.startsWith("INSERT INTO memories")
  ), false);
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
  assert.equal(client.released, true);
});

test("cross-user manual update never acquires a transaction connection", async (t) => {
  const calls = [];
  t.mock.method(pool, "query", async (text, params = []) => {
    calls.push({ text: text.replace(/\s+/g, " ").trim(), params });
    return { rows: [] };
  });
  t.mock.method(pool, "connect", async () => {
    throw new Error("cross-user update must not connect");
  });
  const res = createResponse();

  await updateMemoryController(updateRequest("Prefers Python for DSA."), res);

  assert.equal(res.statusCode, 404);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [USER_ID, MEMORY_ID]);
});
