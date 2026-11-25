import { test } from "node:test";
import assert from "node:assert/strict";

import pool from "../../src/config/database.js";
import {
  createMemory,
  supersedeMemory,
  updateMemory
} from "../../src/repositories/memory.repository.js";
import { formatMemoryContext } from "../../src/utils/memory-format.js";

function normalizeMemoryKey(content) {
  return String(content ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function createMockClient(handler, options = {}) {
  const calls = [];
  let released = false;

  return {
    calls,
    get released() {
      return released;
    },
    async query(text, params = []) {
      const normalized = text.replace(/\s+/g, " ").trim();
      calls.push({ text: normalized, params });

      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
        return options.transactions ? handler(normalized, params) : { rows: [] };
      }

      if (normalized.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }

      if (normalized.startsWith("SELECT 1") && normalized.includes("FROM messages m")) {
        return { rows: options.sourceOwned === false ? [] : [{}] };
      }

      return handler(normalized, params);
    },
    release() {
      released = true;
    }
  };
}

function mockConnect(t, client) {
  t.mock.method(pool, "connect", async () => client);
}

function memoryRow(params, id) {
  return {
    id,
    user_id: params[0],
    memory_type: params[1],
    content: params[2],
    confidence: params[3],
    importance: params[4],
    source_message_id: params[5],
    expires_at: params[6],
    is_active: true
  };
}

function findStoredDuplicate(store, params, text) {
  const permanentOnly = text.includes("AND expires_at IS NULL");
  const requestedExpiry = params[3] == null ? null : new Date(params[3]).getTime();
  const sourceMessageId = params[4] ?? null;

  return store.find((memory) =>
    memory.is_active &&
    (!memory.user_id || memory.user_id === params[0]) &&
    memory.memory_type === params[1] &&
    normalizeMemoryKey(memory.content) === params[2] &&
    (permanentOnly
      ? memory.expires_at == null
      : memory.expires_at != null &&
        new Date(memory.expires_at).getTime() > Date.now() &&
        (new Date(memory.expires_at).getTime() === requestedExpiry ||
          (sourceMessageId && memory.source_message_id === sourceMessageId)))
  ) || null;
}

function findStoredCategory(store, params) {
  const [userId, memoryType, subject, prefix, pattern] = params;
  const category = pattern.includes("backend")
    ? "backend"
    : pattern.includes("frontend")
      ? "frontend"
      : "dsa";

  return store.filter((memory) => {
    const content = String(memory.content).toLowerCase();
    const matchesSubject = (subject === "user" && !content.startsWith("[about:")) ||
      content.startsWith(prefix.toLowerCase());
    const matchesCategory = category === "dsa"
      ? /\b(dsa|data structures?)\b/.test(content)
      : new RegExp(`\\b${category}\\b`).test(content);

    return memory.is_active &&
      (!memory.user_id || memory.user_id === userId) &&
      memory.memory_type === memoryType &&
      memory.expires_at == null &&
      matchesSubject &&
      matchesCategory;
  });
}

function successfulClient(target, options = {}) {
  const store = [...(options.existing || [])];
  let insertCount = 0;

  if (target) {
    store.push({ ...target, is_active: true });
  }

  return createMockClient((text, params) => {
    if (text.startsWith("SELECT id, memory_type, content")) {
      if (text.includes("WHERE id =")) {
        const row = store.find((memory) => memory.id === params[0]);
        return { rows: row ? [row] : [] };
      }

      return { rows: findStoredCategory(store, params) };
    }

    if (text.startsWith("SELECT *") && text.includes("regexp_replace")) {
      const duplicate = findStoredDuplicate(store, params, text);
      return { rows: duplicate ? [duplicate] : [] };
    }

    if (text.startsWith("INSERT INTO memories")) {
      const isHistory = params[2].includes("Previous preference:");
      insertCount += 1;
      const id = isHistory
        ? `history-${store.length}`
        : insertCount === 1 ? "replacement-id" : `replacement-id-${insertCount}`;
      const row = memoryRow(params, id);
      store.push(row);
      return { rows: [row] };
    }

    if (text.startsWith("UPDATE memories")) {
      const row = store.find((memory) => memory.id === params[0] && memory.is_active);

      if (!row) {
        return { rows: [] };
      }

      row.is_active = false;
      return { rows: [{ id: row.id }] };
    }

    throw new Error(`Unexpected query: ${text}`);
  }, options);
}

function createAdvisoryGate() {
  const tails = new Map();
  const acquiredKeys = [];
  const activeByKey = new Map();
  const maxActiveByKey = new Map();
  let active = 0;

  return {
    get active() {
      return active;
    },
    get maxActiveByKey() {
      return maxActiveByKey;
    },
    get acquiredKeys() {
      return acquiredKeys;
    },
    async acquire(key) {
      acquiredKeys.push(key);
      const previous = tails.get(key) || Promise.resolve();
      let release;
      const current = new Promise((resolve) => { release = resolve; });
      tails.set(key, current);
      await previous;
      active += 1;
      const keyActive = (activeByKey.get(key) || 0) + 1;
      activeByKey.set(key, keyActive);
      maxActiveByKey.set(key, Math.max(maxActiveByKey.get(key) || 0, keyActive));

      return () => {
        active -= 1;
        activeByKey.set(key, (activeByKey.get(key) || 1) - 1);
        release();
        if (tails.get(key) === current) {
          tails.delete(key);
        }
      };
    }
  };
}

function serializeAdvisoryLocks(client, gate, onFirstLock) {
  const heldLocks = [];
  const heldKeys = new Set();
  const query = client.query.bind(client);

  client.query = async (text, params = []) => {
    const normalized = text.replace(/\s+/g, " ").trim();

    if (normalized.includes("pg_advisory_xact_lock")) {
      if (!heldKeys.has(params[0])) {
        const firstLock = heldLocks.length === 0;
        heldLocks.push(await gate.acquire(params[0]));
        heldKeys.add(params[0]);
        if (firstLock) onFirstLock?.();
      }
      return { rows: [] };
    }

    const result = await query(text, params);

    if (["COMMIT", "ROLLBACK"].includes(normalized)) {
      for (const release of heldLocks.splice(0)) {
        release();
      }
      heldKeys.clear();
    }

    return result;
  };

  return client;
}

let storeClientCount = 0;

function createStoreClient(store, gate, options = {}) {
  const clientId = storeClientCount++;
  let snapshot = [];
  let snapshotPending = false;
  let insertCount = 0;
  const client = createMockClient((text, params) => {
    if (text === "BEGIN") {
      snapshotPending = false;
      return { rows: [] };
    }

    if (snapshotPending) {
      snapshot = store.map((memory) => ({ ...memory }));
      snapshotPending = false;
    }

    if (text === "ROLLBACK") {
      store.splice(0, store.length, ...snapshot.map((memory) => ({ ...memory })));
      return { rows: [] };
    }

    if (text === "COMMIT") {
      return { rows: [] };
    }

    if (text.startsWith("SELECT id, memory_type, content")) {
      if (text.includes("WHERE id =")) {
        const row = store.find((memory) => memory.id === params[0] &&
          (!memory.user_id || memory.user_id === params[1]));
        return { rows: row ? [row] : [] };
      }

      return { rows: findStoredCategory(store, params) };
    }

    if (text.startsWith("SELECT *") && text.includes("regexp_replace")) {
      const duplicate = findStoredDuplicate(store, params, text);
      return { rows: duplicate ? [duplicate] : [] };
    }

    if (text.startsWith("SELECT * FROM memories")) {
      const row = store.find((memory) => memory.id === params[1] &&
        (!memory.user_id || memory.user_id === params[0]));
      return { rows: row ? [row] : [] };
    }

    if (text.startsWith("INSERT INTO memories")) {
      const isHistory = params[2].includes("Previous preference:");

      if ((isHistory && options.failHistory) || (!isHistory && options.failReplacement)) {
        return { rows: [] };
      }

      const row = memoryRow(params, `insert-${clientId}-${insertCount++}`);
      store.push(row);
      return { rows: [row] };
    }

    if (text.startsWith("UPDATE memories")) {
      if (options.failDeactivation && text.includes("is_active = FALSE")) {
        throw new Error("simulated deactivation failure");
      }

      if (text.includes("is_active = FALSE")) {
        const row = store.find((memory) => memory.id === params[0] &&
          (!memory.user_id || memory.user_id === params[1]) && memory.is_active);

        if (!row) return { rows: [] };
        row.is_active = false;
        return { rows: [{ id: row.id }] };
      }

      const row = store.find((memory) => memory.id === params[1] &&
        (!memory.user_id || memory.user_id === params[0]) && memory.is_active);

      if (!row) return { rows: [] };
      row.content = params[2];
      return { rows: [row] };
    }

    throw new Error(`Unexpected query: ${text}`);
  }, { transactions: true });

  return serializeAdvisoryLocks(client, gate, () => {
    snapshotPending = true;
  });
}

const pythonPreference = {
  id: "python-id",
  memory_type: "preference",
  content: "Prefers Python for backend development.",
  confidence: 0.97,
  importance: 4,
  expires_at: null,
  is_active: true
};

test("Python is atomically replaced by Node.js and retained as historical information", async (t) => {
  const client = successfulClient(pythonPreference);
  mockConnect(t, client);

  const result = await supersedeMemory(
    "user-a",
    "python-id",
    "preference",
    "Prefers Node.js for backend development.",
    { confidence: 0.97, importance: 4, sourceMessageId: "source-id" }
  );

  assert.equal(result.status, "superseded");
  assert.equal(result.memory.content, "Prefers Node.js for backend development.");
  assert.equal(client.calls[0].text, "BEGIN");
  assert.equal(client.calls.at(-1).text, "COMMIT");

  const lockIndex = client.calls.findIndex((call) => call.text.includes("pg_advisory_xact_lock"));
  const targetIndex = client.calls.findIndex((call) => call.text.startsWith("SELECT id, memory_type"));
  const replacementIndex = client.calls.findIndex((call) =>
    call.text.startsWith("INSERT INTO memories") &&
    call.params[2] === "Prefers Node.js for backend development."
  );
  const historyIndex = client.calls.findIndex((call) =>
    call.text.startsWith("INSERT INTO memories") &&
    call.params[2].startsWith("Previous preference:")
  );
  const updateIndex = client.calls.findIndex((call) => call.text.startsWith("UPDATE memories"));

  assert.ok(lockIndex < targetIndex);
  assert.ok(targetIndex < replacementIndex);
  assert.ok(replacementIndex < historyIndex);
  assert.ok(historyIndex < updateIndex);
  assert.deepEqual(client.calls[lockIndex].params, ["memory:user-a:user:preference"]);

  const historyInsert = client.calls[historyIndex];
  assert.equal(historyInsert.params[1], "fact");
  assert.equal(historyInsert.params[2], "Previous preference: Prefers Python for backend development.");
  assert.equal(client.released, true);
});

test("a later Java update keeps Node.js and Python historical, not current", async (t) => {
  const nodePreference = {
    ...pythonPreference,
    id: "node-id",
    content: "Prefers Node.js for backend development."
  };
  const client = successfulClient(nodePreference);
  mockConnect(t, client);

  const result = await supersedeMemory(
    "user-a",
    "node-id",
    "preference",
    "Prefers Java for backend development.",
    { confidence: 0.97, importance: 4, sourceMessageId: "source-id" }
  );

  assert.equal(result.status, "superseded");

  const context = formatMemoryContext([
    { memory_type: result.memory.memory_type, content: result.memory.content },
    { memory_type: "fact", content: "Previous preference: Prefers Python for backend development." },
    {
      memory_type: "fact",
      content: "Previous preference: Prefers Node.js for backend development."
    },
    { memory_type: "preference", content: "[about: rahul] Prefers Java for DSA." }
  ]);

  const currentSection = context.split("Historical preferences")[0];
  assert.match(currentSection, /Prefers Java for backend development\./);
  assert.doesNotMatch(currentSection, /Node\.js|Python/);
  assert.match(context, /Historical preferences \(not current\):[\s\S]*Python[\s\S]*Node\.js/);
  assert.match(context, /About other people the user mentioned[\s\S]*\(rahul\)/);
});

test("an invalid replaces_id rolls back without inserting a replacement", async (t) => {
  const client = createMockClient((text) => {
    if (text.startsWith("SELECT id, memory_type, content")) return { rows: [] };
    throw new Error(`Unexpected query: ${text}`);
  });
  mockConnect(t, client);

  const result = await supersedeMemory(
    "user-a",
    "missing-id",
    "preference",
    "Prefers Node.js for backend development."
  );

  assert.equal(result.status, "invalid_target");
  assert.equal(client.calls.some((call) => call.text.includes("INSERT INTO memories")), false);
  assert.equal(client.calls.some((call) => call.text.startsWith("UPDATE memories")), false);
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
});

test("one user cannot supersede another user's memory", async (t) => {
  const client = createMockClient((text) => {
    if (text.startsWith("SELECT id, memory_type, content")) return { rows: [] };
    throw new Error(`Unexpected query: ${text}`);
  });
  mockConnect(t, client);

  const result = await supersedeMemory(
    "user-b",
    "user-a-memory-id",
    "preference",
    "Prefers Java for backend development."
  );

  const select = client.calls.find((call) => call.text.includes("FOR UPDATE"));
  assert.deepEqual(select.params, ["user-a-memory-id", "user-b"]);
  assert.equal(result.status, "invalid_target");
  assert.equal(client.calls.some((call) => call.text.includes("INSERT INTO memories")), false);
});

test("incompatible type, subject, or expiration prevents superseding", async (t) => {
  const scenarios = [
    {
      name: "different memory type",
      target: { ...pythonPreference, memory_type: "fact" },
      memoryType: "preference"
    },
    {
      name: "different subject",
      target: { ...pythonPreference, content: "[about: rahul] Prefers Java for DSA." },
      memoryType: "preference"
    },
    {
      name: "ambiguous subject",
      target: { ...pythonPreference, content: "He prefers Java for DSA." },
      memoryType: "preference"
    },
    {
      name: "temporary target",
      target: { ...pythonPreference, expires_at: new Date("2026-12-01T00:00:00Z") },
      memoryType: "preference"
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const client = createMockClient((text) => {
        if (text.startsWith("SELECT id, memory_type, content")) return { rows: [scenario.target] };
        throw new Error(`Unexpected query: ${text}`);
      });
      mockConnect(t, client);

      const result = await supersedeMemory(
        "user-a",
        scenario.target.id,
        scenario.memoryType,
        "Prefers Node.js for backend development."
      );

      assert.equal(result.status, "incompatible_target");
      assert.equal(client.calls.some((call) => call.text.includes("INSERT INTO memories")), false);
      assert.equal(client.calls.at(-1).text, "ROLLBACK");
    });
  }
});

test("a failed replacement insert rolls back without deactivating the old memory", async (t) => {
  const client = createMockClient((text) => {
    if (text.startsWith("SELECT id, memory_type, content")) return { rows: [pythonPreference] };
    if (text.startsWith("SELECT *") && text.includes("regexp_replace")) return { rows: [] };
    if (text.startsWith("INSERT INTO memories")) return { rows: [] };
    throw new Error(`Unexpected query: ${text}`);
  });
  mockConnect(t, client);

  const result = await supersedeMemory(
    "user-a",
    "python-id",
    "preference",
    "Prefers Node.js for backend development."
  );

  assert.equal(result.status, "invalid_source");
  assert.equal(client.calls.some((call) => call.text.startsWith("UPDATE memories")), false);
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
});

test("a failed deactivation rolls back the transaction and reports failure", async (t) => {
  const client = createMockClient((text, params) => {
    if (text.startsWith("SELECT id, memory_type, content")) return { rows: [pythonPreference] };
    if (text.startsWith("SELECT *") && text.includes("regexp_replace")) return { rows: [] };
    if (text.startsWith("INSERT INTO memories")) {
      return { rows: [memoryRow(params, params[2].startsWith("Previous preference:") ? "history-id" : "replacement-id")] };
    }
    if (text.startsWith("UPDATE memories")) throw new Error("database update failed");
    throw new Error(`Unexpected query: ${text}`);
  });
  mockConnect(t, client);

  await assert.rejects(
    supersedeMemory(
      "user-a",
      "python-id",
      "preference",
      "Prefers Node.js for backend development."
    ),
    /Memory supersede transaction failed/
  );

  assert.equal(client.calls.some((call) => call.text === "COMMIT"), false);
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
  assert.equal(client.released, true);
});

test("an exact create retry returns the existing memory without another insert", async (t) => {
  const client = successfulClient(null);
  mockConnect(t, client);

  const first = await createMemory(
    "user-a",
    "preference",
    "Prefers Node.js for backend development."
  );
  const second = await createMemory(
    "user-a",
    "preference",
    "prefers node js for backend development!"
  );

  assert.equal(second.id, first.id);
  assert.equal(client.calls.filter((call) => call.text.startsWith("INSERT INTO memories")).length, 1);
  assert.equal(client.calls.filter((call) => call.text.includes("pg_advisory_xact_lock")).length, 2);
});

test("an invalid source message is rejected even when an exact duplicate exists", async (t) => {
  const existing = {
    ...pythonPreference,
    content: "Prefers Node.js for backend development.",
    is_active: true
  };
  const client = successfulClient(null, { existing: [existing], sourceOwned: false });
  mockConnect(t, client);

  const result = await createMemory(
    "user-a",
    "preference",
    "Prefers Node.js for backend development.",
    { sourceMessageId: "other-users-message" }
  );

  assert.equal(result, null);
  assert.equal(client.calls.some((call) => call.text.startsWith("INSERT INTO memories")), false);
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
});

test("historical preference snapshots are not duplicated", async (t) => {
  const existingHistory = {
    id: "history-id",
    user_id: "user-a",
    memory_type: "fact",
    content: "Previous preference: Prefers Python for backend development.",
    confidence: 0.97,
    importance: 4,
    expires_at: null,
    is_active: true
  };
  const client = successfulClient(pythonPreference, { existing: [existingHistory] });
  mockConnect(t, client);

  const result = await supersedeMemory(
    "user-a",
    "python-id",
    "preference",
    "Prefers Node.js for backend development.",
    { confidence: 0.97, importance: 4 }
  );

  assert.equal(result.status, "superseded");
  assert.equal(client.calls.filter((call) =>
    call.text.startsWith("INSERT INTO memories") &&
    call.params[2].startsWith("Previous preference:")
  ).length, 0);
});

test("a permanent replacement does not reuse a temporary duplicate", async (t) => {
  const temporary = {
    ...pythonPreference,
    id: "temporary-node",
    content: "Prefers Node.js for backend development.",
    expires_at: new Date("2026-12-01T00:00:00Z")
  };
  const client = successfulClient(pythonPreference, { existing: [temporary] });
  mockConnect(t, client);

  const result = await supersedeMemory(
    "user-a",
    "python-id",
    "preference",
    "Prefers Node.js for backend development.",
    { confidence: 0.97, importance: 4 }
  );

  assert.equal(result.status, "superseded");
  assert.equal(result.memory.id, "replacement-id");
  assert.equal(result.memory.expires_at, null);
  assert.equal(client.calls.some((call) =>
    call.text.startsWith("INSERT INTO memories") &&
    call.params[2] === "Prefers Node.js for backend development."
  ), true);
});

test("scoped serialization lets concurrent replacements reuse one current preference", async (t) => {
  const targets = [
    { ...pythonPreference, id: "python-id" },
    {
      ...pythonPreference,
      id: "ruby-id",
      content: "Prefers Ruby for backend development."
    }
  ];
  const store = targets.map((target) => ({ ...target, is_active: true }));
  let lockTail = Promise.resolve();
  let connectIndex = 0;

  const makeClient = (target) => {
    let releaseLock;
    const client = createMockClient((text, params) => {
      if (text.startsWith("SELECT id, memory_type, content")) {
        if (text.includes("WHERE id =")) {
          const row = store.find((memory) => memory.id === params[0]);
          return { rows: row ? [row] : [] };
        }

        return { rows: findStoredCategory(store, params) };
      }

      if (text.startsWith("SELECT *") && text.includes("regexp_replace")) {
        const duplicate = findStoredDuplicate(store, params, text);
        return { rows: duplicate ? [duplicate] : [] };
      }

      if (text.startsWith("INSERT INTO memories")) {
        const isHistory = params[2].startsWith("Previous preference:");
        const row = memoryRow(params, isHistory ? `history-${store.length}` : "replacement-id");
        store.push(row);
        return { rows: [row] };
      }

      if (text.startsWith("UPDATE memories")) {
        const row = store.find((memory) => memory.id === params[0] && memory.is_active);

        if (!row) {
          return { rows: [] };
        }

        row.is_active = false;
        return { rows: [{ id: row.id }] };
      }

      throw new Error(`Unexpected query: ${text}`);
    });
    const query = client.query.bind(client);

    client.query = async (text, params = []) => {
      const normalized = text.replace(/\s+/g, " ").trim();

      if (
        normalized.includes("pg_advisory_xact_lock") &&
        params[0] === "memory:user-a:user:preference"
      ) {
        const previous = lockTail;
        lockTail = new Promise((resolve) => {
          releaseLock = resolve;
        });
        await previous;
        return { rows: [] };
      }

      const result = await query(text, params);

      if (["COMMIT", "ROLLBACK"].includes(normalized)) {
        releaseLock?.();
      }

      return result;
    };

    return client;
  };

  const clients = targets.map(makeClient);
  t.mock.method(pool, "connect", async () => clients[connectIndex++]);

  const results = await Promise.all(targets.map((target) => supersedeMemory(
    "user-a",
    target.id,
    "preference",
    "Prefers Node.js for backend development.",
    { confidence: 0.97, importance: 4 }
  )));

  assert.deepEqual(results.map((result) => result.status), ["superseded", "superseded"]);
  assert.equal(results[0].memory.id, results[1].memory.id);
  assert.equal(store.filter((memory) =>
    memory.content === "Prefers Node.js for backend development."
  ).length, 1);
  assert.equal(store.filter((memory) =>
    memory.content.startsWith("Previous preference:")
  ).length, 2);
  assert.equal(targets.every((target) => !store.find((memory) => memory.id === target.id).is_active), true);
});

test("permanent and temporary creates never reuse each other's duplicates", async (t) => {
  const content = "Prefers Node.js for backend development.";
  const expiry = "2099-12-01T00:00:00.000Z";
  const temporary = {
    ...pythonPreference,
    id: "temporary-node",
    content,
    expires_at: new Date(expiry),
    is_active: true
  };
  const permanent = { ...temporary, id: "permanent-node", expires_at: null };
  const scenarios = [
    { existing: temporary, expiresAt: null, inserted: true },
    { existing: permanent, expiresAt: expiry, inserted: true },
    { existing: temporary, expiresAt: expiry, inserted: false },
    { existing: { ...temporary, expires_at: new Date("2099-12-02T00:00:00.000Z") }, expiresAt: expiry, inserted: true }
  ];

  for (const scenario of scenarios) {
    await t.test(`${scenario.existing.expires_at ? "temporary" : "permanent"} to ${scenario.expiresAt ? "temporary" : "permanent"} ${scenario.inserted ? "inserts" : "reuses"}`, async (t) => {
      const client = successfulClient(null, { existing: [scenario.existing] });
      mockConnect(t, client);
      const result = await createMemory("user-a", "preference", content, {
        expiresAt: scenario.expiresAt
      });

      assert.ok(result);
      assert.equal(client.calls.some((call) => call.text.startsWith("INSERT INTO memories")), scenario.inserted);
      assert.equal(result.id, scenario.inserted ? "replacement-id" : scenario.existing.id);
    });
  }
});

test("temporary retries reuse the same source even when expiry shifts", async (t) => {
  const content = "Travelling this week.";
  const existing = {
    ...pythonPreference,
    id: "temporary-trip",
    memory_type: "commitment",
    content,
    expires_at: new Date("2099-12-01T00:00:00.000Z"),
    source_message_id: "source-id",
    is_active: true
  };
  const client = successfulClient(null, { existing: [existing] });
  mockConnect(t, client);

  const result = await createMemory("user-a", "commitment", content, {
    expiresAt: "2099-12-02T00:00:00.000Z",
    sourceMessageId: "source-id"
  });

  assert.equal(result.id, existing.id);
  assert.equal(client.calls.some((call) => call.text.startsWith("INSERT INTO memories")), false);
});

test("an exact supersede retry is idempotent and creates no extra history", async (t) => {
  const client = successfulClient(pythonPreference);
  mockConnect(t, client);
  const request = () => supersedeMemory(
    "user-a",
    "python-id",
    "preference",
    "Prefers Node.js for backend development.",
    { confidence: 0.97, importance: 4 }
  );

  const first = await request();
  const second = await request();

  assert.equal(first.status, "superseded");
  assert.deepEqual(second, first);
  assert.equal(client.calls.filter((call) =>
    call.text.startsWith("INSERT INTO memories") && call.params[2].startsWith("Previous preference:")
  ).length, 1);
  assert.equal(client.calls.filter((call) => call.text.startsWith("UPDATE memories")).length, 1);
});

test("a different-value retry after another update is stale and does not deactivate the winner", async (t) => {
  const client = successfulClient(pythonPreference);
  mockConnect(t, client);

  await supersedeMemory("user-a", "python-id", "preference", "Prefers Node.js for backend development.");
  const stale = await supersedeMemory("user-a", "python-id", "preference", "Prefers Go for backend development.");

  assert.equal(stale.status, "stale_target");
  assert.equal(client.calls.filter((call) => call.text.startsWith("UPDATE memories")).length, 1);
  assert.equal(client.calls.some((call) =>
    call.text.startsWith("INSERT INTO memories") && call.params[2] === "Prefers Go for backend development."
  ), false);
});

test("a supersede retry after simulated rollback executes normally", async (t) => {
  const store = [{ ...pythonPreference, is_active: true }];
  let snapshot = [];
  let failDeactivation = true;
  const client = createMockClient((text, params) => {
    if (text === "BEGIN") {
      snapshot = store.map((memory) => ({ ...memory }));
      return { rows: [] };
    }

    if (text === "ROLLBACK") {
      store.splice(0, store.length, ...snapshot.map((memory) => ({ ...memory })));
      return { rows: [] };
    }

    if (text === "COMMIT") {
      return { rows: [] };
    }

    if (text.startsWith("SELECT id, memory_type, content")) {
      if (text.includes("WHERE id =")) {
        const row = store.find((memory) => memory.id === params[0]);
        return { rows: row ? [row] : [] };
      }

      return { rows: findStoredCategory(store, params) };
    }

    if (text.startsWith("SELECT *") && text.includes("regexp_replace")) {
      const duplicate = findStoredDuplicate(store, params, text);
      return { rows: duplicate ? [duplicate] : [] };
    }

    if (text.startsWith("INSERT INTO memories")) {
      const row = memoryRow(params, `insert-${store.length}`);
      store.push(row);
      return { rows: [row] };
    }

    if (text.startsWith("UPDATE memories")) {
      if (failDeactivation) throw new Error("simulated failure");
      const row = store.find((memory) => memory.id === params[0] && memory.is_active);
      if (!row) return { rows: [] };
      row.is_active = false;
      return { rows: [{ id: row.id }] };
    }

    throw new Error(`Unexpected query: ${text}`);
  }, { transactions: true });
  mockConnect(t, client);
  const request = () => supersedeMemory("user-a", "python-id", "preference", "Prefers Node.js for backend development.");

  await assert.rejects(request(), /Memory supersede transaction failed/);
  assert.equal(store.length, 1);
  assert.equal(store[0].is_active, true);

  failDeactivation = false;
  const retry = await request();
  assert.equal(retry.status, "superseded");
  assert.equal(store.filter((memory) => memory.is_active && memory.memory_type === "preference").length, 1);
  assert.equal(store.filter((memory) => memory.content.startsWith("Previous preference:")).length, 1);
});

test("uncategorized preferences are not destructively grouped by semantic guess", async (t) => {
  const unrelated = {
    ...pythonPreference,
    id: "ruby-id",
    content: "Prefers Ruby.",
    is_active: true
  };
  const client = successfulClient({ ...pythonPreference, content: "Prefers Python." }, {
    existing: [unrelated]
  });
  mockConnect(t, client);

  const result = await supersedeMemory("user-a", "python-id", "preference", "Prefers Node.js.");

  assert.equal(result.status, "superseded");
  const deactivated = client.calls.filter((call) => call.text.startsWith("UPDATE memories"));
  assert.deepEqual(deactivated.map((call) => call.params[0]), ["python-id"]);
});

test("concurrent different-value category updates leave one active preference", async (t) => {
  const targets = [
    { ...pythonPreference, id: "python-id", content: "Prefers Python for backend development." },
    { ...pythonPreference, id: "ruby-id", content: "Prefers Ruby for backend development." }
  ];
  const store = targets.map((target) => ({ ...target, is_active: true }));
  let lockTail = Promise.resolve();
  let connectIndex = 0;

  const makeClient = () => {
    let releaseLock;
    const client = createMockClient((text, params) => {
      if (text.startsWith("SELECT id, memory_type, content")) {
        if (text.includes("WHERE id =")) {
          const row = store.find((memory) => memory.id === params[0]);
          return { rows: row ? [row] : [] };
        }

        return { rows: findStoredCategory(store, params) };
      }

      if (text.startsWith("SELECT *") && text.includes("regexp_replace")) {
        const duplicate = findStoredDuplicate(store, params, text);
        return { rows: duplicate ? [duplicate] : [] };
      }

      if (text.startsWith("INSERT INTO memories")) {
        const row = memoryRow(params, `insert-${store.length}`);
        store.push(row);
        return { rows: [row] };
      }

      if (text.startsWith("UPDATE memories")) {
        const row = store.find((memory) => memory.id === params[0] && memory.is_active);
        if (!row) return { rows: [] };
        row.is_active = false;
        return { rows: [{ id: row.id }] };
      }

      throw new Error(`Unexpected query: ${text}`);
    });
    const query = client.query.bind(client);

    client.query = async (text, params = []) => {
      const normalized = text.replace(/\s+/g, " ").trim();

      if (
        normalized.includes("pg_advisory_xact_lock") &&
        params[0] === "memory:user-a:user:preference"
      ) {
        const previous = lockTail;
        lockTail = new Promise((resolve) => { releaseLock = resolve; });
        await previous;
        return { rows: [] };
      }

      const result = await query(text, params);
      if (["COMMIT", "ROLLBACK"].includes(normalized)) releaseLock?.();
      return result;
    };

    return client;
  };

  const clients = [makeClient(), makeClient()];
  t.mock.method(pool, "connect", async () => clients[connectIndex++]);
  const results = await Promise.all([
    supersedeMemory("user-a", "python-id", "preference", "Prefers Node.js for backend development."),
    supersedeMemory("user-a", "ruby-id", "preference", "Prefers Java for backend development.")
  ]);

  assert.deepEqual(results.map((result) => result.status), ["superseded", "stale_target"]);
  assert.equal(store.filter((memory) =>
    memory.is_active && memory.memory_type === "preference" && memory.content.includes("backend")
  ).length, 1);
  assert.equal(store.some((memory) => memory.content === "Prefers Java for backend development."), false);
  assert.equal(store.filter((memory) => memory.content.startsWith("Previous preference:")).length, 2);
});

test("superseding an old preference reuses the active winner without deactivating it", async (t) => {
  const python = {
    ...pythonPreference,
    user_id: "user-a",
    source_message_id: "old-source",
    confidence: 0.72,
    importance: 2
  };
  const node = {
    ...pythonPreference,
    id: "node-id",
    user_id: "user-a",
    content: "Prefers Node.js for backend development.",
    source_message_id: "winner-source"
  };
  const store = [python, node];
  const gate = createAdvisoryGate();
  const client = createStoreClient(store, gate);
  mockConnect(t, client);
  const request = () => supersedeMemory(
    "user-a",
    "python-id",
    "preference",
    node.content,
    { confidence: 0.99, importance: 5, sourceMessageId: "replacement-source" }
  );

  const first = await request();
  const retry = await request();

  assert.equal(first.status, "superseded");
  assert.equal(first.memory.id, "node-id");
  assert.deepEqual(retry, first);
  assert.equal(store.find((memory) => memory.id === "node-id").is_active, true);
  assert.equal(store.find((memory) => memory.id === "python-id").is_active, false);
  assert.equal(store.filter((memory) =>
    memory.is_active && memory.memory_type === "preference" && memory.expires_at == null
  ).length, 1);
  assert.equal(client.calls.filter((call) => call.text.startsWith("UPDATE memories")).length, 1);

  const history = client.calls.find((call) =>
    call.text.startsWith("INSERT INTO memories") && call.params[2].startsWith("Previous preference:")
  );
  assert.equal(history.params[3], 0.72);
  assert.equal(history.params[4], 2);
  assert.equal(history.params[5], "old-source");
});

test("a stale supersede retry cannot deactivate a newer category winner", async (t) => {
  const store = [{ ...pythonPreference, user_id: "user-a", is_active: true }];
  const gate = createAdvisoryGate();
  const client = createStoreClient(store, gate);
  mockConnect(t, client);

  const nodeResult = await supersedeMemory(
    "user-a",
    "python-id",
    "preference",
    "Prefers Node.js for backend development."
  );
  const javaResult = await supersedeMemory(
    "user-a",
    nodeResult.memory.id,
    "preference",
    "Prefers Java for backend development."
  );
  const stale = await supersedeMemory(
    "user-a",
    "python-id",
    "preference",
    "Prefers Go for backend development."
  );

  assert.equal(javaResult.status, "superseded");
  assert.equal(stale.status, "stale_target");
  assert.equal(store.some((memory) => memory.content === "Prefers Go for backend development."), false);
  assert.deepEqual(store.filter((memory) =>
    memory.is_active && memory.memory_type === "preference"
  ).map((memory) => memory.content), ["Prefers Java for backend development."]);
});

test("a failed supersede replacement rolls back and can be retried", async (t) => {
  const store = [{ ...pythonPreference, user_id: "user-a", is_active: true }];
  const gate = createAdvisoryGate();
  const options = { failReplacement: true };
  const client = createStoreClient(store, gate, options);
  mockConnect(t, client);
  const request = () => supersedeMemory(
    "user-a",
    "python-id",
    "preference",
    "Prefers Node.js for backend development."
  );

  const failed = await request();

  assert.equal(failed.status, "invalid_source");
  assert.equal(store.length, 1);
  assert.equal(store[0].is_active, true);
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
  assert.equal(gate.active, 0);

  options.failReplacement = false;
  const retry = await request();
  assert.equal(retry.status, "superseded");
  assert.equal(store.filter((memory) =>
    memory.is_active && memory.memory_type === "preference"
  ).length, 1);
});

test("contradictory permanent creates keep one current preference in either direction", async (t) => {
  const scenarios = [
    ["Prefers Python for backend development.", "Prefers Node.js for backend development."],
    ["Prefers Node.js for backend development.", "Prefers Python for backend development."]
  ];

  for (const [firstContent, secondContent] of scenarios) {
    await t.test(`${firstContent} then ${secondContent}`, async (t) => {
      const store = [];
      const gate = createAdvisoryGate();
      const client = createStoreClient(store, gate);
      mockConnect(t, client);

      const first = await createMemory("user-a", "preference", firstContent, {
        confidence: 0.73,
        importance: 2,
        sourceMessageId: "old-source"
      });
      const second = await createMemory("user-a", "preference", secondContent, {
        confidence: 0.99,
        importance: 5,
        sourceMessageId: "replacement-source"
      });

      assert.ok(first);
      assert.ok(second);
      assert.equal(store.find((memory) => memory.id === first.id).is_active, false);
      assert.equal(store.find((memory) => memory.id === second.id).is_active, true);
      assert.equal(store.filter((memory) =>
        memory.is_active && memory.memory_type === "preference"
      ).length, 1);
      assert.equal(store.filter((memory) =>
        memory.memory_type === "fact" && memory.content.startsWith("Previous preference:")
      ).length, 1);
      const history = client.calls.find((call) =>
        call.text.startsWith("INSERT INTO memories") && call.params[2].startsWith("Previous preference:")
      );
      assert.equal(history.params[3], 0.73);
      assert.equal(history.params[4], 2);
      assert.equal(history.params[5], "old-source");
      assert.equal(gate.active, 0);
    });
  }
});

test("concurrent different-value creates serialize and leave one current preference", async (t) => {
  const store = [{ ...pythonPreference, user_id: "user-a", is_active: true }];
  const gate = createAdvisoryGate();
  const clients = [createStoreClient(store, gate), createStoreClient(store, gate)];
  let connectIndex = 0;
  t.mock.method(pool, "connect", async () => clients[connectIndex++]);

  const results = await Promise.all([
    createMemory("user-a", "preference", "Prefers Node.js for backend development."),
    createMemory("user-a", "preference", "Prefers Java for backend development.")
  ]);

  assert.ok(results.every(Boolean));
  assert.equal(gate.maxActiveByKey.get("memory:user-a:user:preference"), 1);
  assert.equal(store.filter((memory) =>
    memory.is_active && memory.memory_type === "preference"
  ).length, 1);
  assert.equal(store.filter((memory) =>
    memory.memory_type === "fact" && memory.content.startsWith("Previous preference:")
  ).length, 2);
});

test("concurrent creates isolate different users and different subjects", async (t) => {
  const scenarios = [
    {
      name: "different users",
      rows: [
        { ...pythonPreference, id: "a-python", user_id: "user-a", content: "Prefers Python for backend development." },
        { ...pythonPreference, id: "b-python", user_id: "user-b", content: "Prefers Python for backend development." }
      ],
      requests: [
        ["user-a", "Prefers Node.js for backend development."],
        ["user-b", "Prefers Java for backend development."]
      ],
      keys: ["memory:user-a:user:preference", "memory:user-b:user:preference"]
    },
    {
      name: "different subjects",
      rows: [
        { ...pythonPreference, id: "rahul-python", user_id: "user-a", content: "[about: rahul] Prefers Python for backend development." },
        { ...pythonPreference, id: "aman-python", user_id: "user-a", content: "[about: aman] Prefers Python for backend development." }
      ],
      requests: [
        ["user-a", "[about: rahul] Prefers Node.js for backend development."],
        ["user-a", "[about: aman] Prefers Go for backend development."]
      ],
      keys: ["memory:user-a:rahul:preference", "memory:user-a:aman:preference"]
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const store = scenario.rows.map((row) => ({ ...row, is_active: true }));
      const gate = createAdvisoryGate();
      const clients = [createStoreClient(store, gate), createStoreClient(store, gate)];
      let connectIndex = 0;
      t.mock.method(pool, "connect", async () => clients[connectIndex++]);

      const results = await Promise.all(scenario.requests.map(([userId, content]) =>
        createMemory(userId, "preference", content)
      ));

      assert.ok(results.every(Boolean));
      assert.deepEqual(gate.acquiredKeys.filter((key) => key.endsWith(":preference")), scenario.keys);
      assert.equal(store.filter((memory) =>
        memory.is_active && memory.memory_type === "preference"
      ).length, 2);
      assert.equal(store.filter((memory) =>
        memory.memory_type === "fact" && memory.content.includes("Previous preference:")
      ).length, 2);
    });
  }
});

test("concurrent creates in different categories preserve both current preferences", async (t) => {
  const store = [
    { ...pythonPreference, id: "backend-python", user_id: "user-a", is_active: true },
    {
      ...pythonPreference,
      id: "frontend-react",
      user_id: "user-a",
      content: "Prefers React for frontend development.",
      is_active: true
    }
  ];
  const gate = createAdvisoryGate();
  const clients = [createStoreClient(store, gate), createStoreClient(store, gate)];
  let connectIndex = 0;
  t.mock.method(pool, "connect", async () => clients[connectIndex++]);

  const results = await Promise.all([
    createMemory("user-a", "preference", "Prefers Node.js for backend development."),
    createMemory("user-a", "preference", "Prefers Vue for frontend development.")
  ]);

  assert.ok(results.every(Boolean));
  assert.equal(gate.maxActiveByKey.get("memory:user-a:user:preference"), 1);
  assert.equal(store.filter((memory) =>
    memory.is_active && memory.memory_type === "preference"
  ).length, 2);
  assert.equal(store.some((memory) =>
    memory.is_active && memory.content.includes("backend") && memory.content.includes("Node.js")
  ), true);
  assert.equal(store.some((memory) =>
    memory.is_active && memory.content.includes("frontend") && memory.content.includes("Vue")
  ), true);
});

test("create rollback restores state and releases locks after replacement or history failure", async (t) => {
  for (const stage of ["replacement", "history"]) {
    await t.test(stage, async (t) => {
      const store = [{ ...pythonPreference, user_id: "user-a", is_active: true }];
      const gate = createAdvisoryGate();
      const options = stage === "replacement" ? { failReplacement: true } : { failHistory: true };
      const client = createStoreClient(store, gate, options);
      mockConnect(t, client);
      const request = () => createMemory(
        "user-a",
        "preference",
        "Prefers Node.js for backend development."
      );

      if (stage === "replacement") {
        assert.equal(await request(), null);
      } else {
        await assert.rejects(request(), /Memory create transaction failed/);
      }

      assert.equal(store.length, 1);
      assert.equal(store[0].is_active, true);
      assert.equal(client.calls.at(-1).text, "ROLLBACK");
      assert.equal(gate.active, 0);

      options.failReplacement = false;
      options.failHistory = false;
      assert.ok(await request());
      assert.equal(store.filter((memory) =>
        memory.is_active && memory.memory_type === "preference"
      ).length, 1);
    });
  }
});

test("temporary preference updates do not deactivate permanent category preferences", async (t) => {
  const store = [
    { ...pythonPreference, id: "permanent-python", user_id: "user-a", is_active: true },
    {
      ...pythonPreference,
      id: "temporary-node",
      user_id: "user-a",
      content: "Prefers Node.js for backend development.",
      expires_at: new Date("2099-12-01T00:00:00.000Z"),
      is_active: true
    }
  ];
  const gate = createAdvisoryGate();
  const client = createStoreClient(store, gate);
  mockConnect(t, client);

  const result = await updateMemory(
    "user-a",
    "temporary-node",
    "Prefers Java for backend development."
  );

  assert.equal(result.status, "updated");
  assert.equal(store.find((memory) => memory.id === "permanent-python").is_active, true);
  assert.equal(store.find((memory) => memory.id === "temporary-node").content,
    "Prefers Java for backend development.");
  assert.equal(client.calls.some((call) =>
    call.text.startsWith("SELECT id, memory_type, content") && !call.text.includes("WHERE id =")
  ), false);
});

test("conflicting concurrent manual updates leave one active winner", async (t) => {
  const store = [
    { ...pythonPreference, id: "python-id", user_id: "user-a", is_active: true },
    {
      ...pythonPreference,
      id: "ruby-id",
      user_id: "user-a",
      content: "Prefers Ruby for backend development.",
      is_active: true
    }
  ];
  const gate = createAdvisoryGate();
  const clients = [createStoreClient(store, gate), createStoreClient(store, gate)];
  let connectIndex = 0;
  t.mock.method(pool, "connect", async () => clients[connectIndex++]);

  const results = await Promise.all([
    updateMemory("user-a", "python-id", "Prefers Node.js for backend development."),
    updateMemory("user-a", "ruby-id", "Prefers Java for backend development.")
  ]);

  assert.deepEqual(results.map((result) => result.status), ["updated", "not_found"]);
  assert.equal(gate.maxActiveByKey.get("memory:user-a:user:preference"), 1);
  assert.equal(store.filter((memory) =>
    memory.is_active && memory.memory_type === "preference"
  ).length, 1);
  assert.equal(store.filter((memory) =>
    memory.memory_type === "fact" && memory.content.startsWith("Previous preference:")
  ).length, 2);
});

test("category row locks are narrowed by owner, subject, category, and deterministic order", async (t) => {
  const store = [
    { ...pythonPreference, id: "python-id", user_id: "user-a", is_active: true },
    { ...pythonPreference, id: "dsa-java", user_id: "user-a", content: "Prefers Java for DSA.", is_active: true },
    { ...pythonPreference, id: "rahul-java", user_id: "user-a", content: "[about: rahul] Prefers Java for backend development.", is_active: true },
    { ...pythonPreference, id: "other-user", user_id: "user-b", content: "Prefers Ruby for backend development.", is_active: true }
  ];
  const gate = createAdvisoryGate();
  const client = createStoreClient(store, gate);
  mockConnect(t, client);

  await createMemory("user-a", "preference", "Prefers Node.js for backend development.");

  const categoryLock = client.calls.find((call) =>
    call.text.startsWith("SELECT id, memory_type, content") && !call.text.includes("WHERE id =")
  );
  assert.match(categoryLock.text, /user_id = \$1/);
  assert.match(categoryLock.text, /\$3 = 'user'/);
  assert.match(categoryLock.text, /content ~\* \$5/);
  assert.match(categoryLock.text, /ORDER BY updated_at, id/);
  assert.match(categoryLock.text, /FOR UPDATE/);
  assert.deepEqual(categoryLock.params, [
    "user-a",
    "preference",
    "user",
    "[about: user] ",
    "\\mbackend\\M"
  ]);
  assert.deepEqual(client.calls.filter((call) =>
    call.text.startsWith("UPDATE memories")
  ).map((call) => call.params[0]), ["python-id"]);
  assert.equal(store.find((memory) => memory.id === "dsa-java").is_active, true);
  assert.equal(store.find((memory) => memory.id === "rahul-java").is_active, true);
  assert.equal(store.find((memory) => memory.id === "other-user").is_active, true);
});
