import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import pool from "../src/config/database.js";
import { validateIntegrationEnvironment } from "../src/config/integration-env.js";
import { createConversation } from "../src/repositories/conversation.repository.js";
import {
  createMemory,
  deactivateMemory,
  getMemoryById,
  getRelevantMemories,
  getUserMemories,
  supersedeMemory,
  updateMemory
} from "../src/repositories/memory.repository.js";
import { createMessage } from "../src/repositories/message.repository.js";
import { retrieveMemoryContext } from "../src/services/agent.service.js";
import {
  analyzeMemoryAttribution,
  getPreferenceCategory,
  planMemoryActions
} from "../src/utils/memory-format.js";
import { readAuthUserVerificationRows } from "./phase1-auth.helpers.js";

if (process.env.INTEGRATION_MODE !== "true") {
  throw new Error("Approved isolated integration mode is required.");
}

validateIntegrationEnvironment();

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(TEST_DIR, "../phase2-identities.integration.local.json"), "utf8"));
const RUN_ID = `phase2-fix-${randomUUID()}`;
const USER_A = manifest.userAId;
const USER_B = manifest.userBId;
const ORIGINAL_USER_IDS = [
  "cf2740d5-eef5-44a8-ab70-3070bff87545",
  "dcc2ca1a-06f9-4de6-8062-a52a2b20fa8b",
  "374a7038-fa53-4dd9-aa15-c5cc576577d1",
  "2d22e2fb-8159-4ae7-b887-5866e60ef8b9"
];
const PHASE1_CONVERSATION_IDS = [
  "0b40b29f-2cb8-4e00-9c10-2776dd0cbb01",
  "869477b7-2a4f-4320-95b7-bd14fc04ef95"
];
const PHASE1_MEMORY_IDS = [
  "1135931f-c057-4013-9e54-0938fd54477e",
  "3e916603-7e7d-402b-85e4-9f9762f4de71"
];
const KNOWN_RECORD_IDS = [
  "2a0db733-b825-4271-98e4-bf7b33b950cf",
  "e0f8218d-8a1d-435f-95fb-b93483e9a3dd",
  "6e53a611-fac4-4f13-a228-daf8507b04be",
  "b049d213-12ca-4a12-9871-d36f3e1fe5b5",
  "0773ea8d-4c80-4e52-b10e-676f2246e332"
];
const EXPECTED_PHASE1_CONVERSATION_HASHES = {
  "0b40b29f-2cb8-4e00-9c10-2776dd0cbb01": "6fafe96bf8133d9b252d",
  "869477b7-2a4f-4320-95b7-bd14fc04ef95": "ab514e91480862efdce0"
};
const EXPECTED_PHASE1_MEMORY_HASHES = {
  "1135931f-c057-4013-9e54-0938fd54477e": "356bd1a4d81fdd3dea18",
  "3e916603-7e7d-402b-85e4-9f9762f4de71": "776259dfb74e3f613fdb"
};
const EXPECTED_ORIGINAL_USER_HASHES = {
  "2d22e2fb-8159-4ae7-b887-5866e60ef8b9": "15e9c0628f50e25f0648",
  "374a7038-fa53-4dd9-aa15-c5cc576577d1": "a475a32ca5398e3fac88",
  "cf2740d5-eef5-44a8-ab70-3070bff87545": "14a12c82320632bb4c4c",
  "dcc2ca1a-06f9-4de6-8062-a52a2b20fa8b": "e32afb4a84d03abfdcff"
};

let baseline;
let fixture;

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
}

function normalizeMemoryKey(content) {
  return String(content ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function readMemory(memoryId) {
  const result = await pool.query("SELECT * FROM memories WHERE id = $1", [memoryId]);
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function readCounts() {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM neon_auth."user") AS auth_users,
       (SELECT count(*)::int FROM conversations) AS conversations,
       (SELECT count(*)::int FROM memories) AS memories,
       (SELECT count(*)::int FROM memories WHERE is_active = TRUE) AS active_memories,
       (SELECT count(*)::int FROM messages) AS messages,
       (SELECT count(*)::int FROM reminders) AS reminders,
       (SELECT count(*)::int FROM agent_tool_logs) AS agent_tool_logs,
       (SELECT count(*)::int FROM neon_auth.session) AS auth_sessions`
  );

  return result.rows[0];
}

async function readPreservationState() {
  const userIds = await pool.query('SELECT id FROM neon_auth."user" ORDER BY id');
  const [users, conversations, memories, messages, sessions] = await Promise.all([
    readAuthUserVerificationRows(pool, userIds.rows.map((row) => row.id)),
    pool.query("SELECT * FROM conversations ORDER BY id"),
    pool.query("SELECT * FROM memories ORDER BY id"),
    pool.query("SELECT * FROM messages ORDER BY id"),
    pool.query(
      'SELECT id, "userId", "createdAt", "updatedAt", "expiresAt" FROM neon_auth.session ORDER BY id'
    )
  ]);

  return {
    users: users,
    conversations: conversations.rows,
    memories: memories.rows,
    messages: messages.rows,
    sessions: sessions.rows
  };
}

async function activeCategoryPreferences(userId, category, subject = "user") {
  const result = await pool.query(
    `SELECT *
     FROM memories
     WHERE user_id = $1
       AND memory_type = 'preference'
       AND is_active = TRUE
       AND expires_at IS NULL
     ORDER BY id`,
    [userId]
  );

  return result.rows.filter((memory) =>
    analyzeMemoryAttribution(memory.content).subject === subject &&
    getPreferenceCategory(memory.content) === category
  );
}

async function memorySnapshot() {
  const result = await pool.query("SELECT * FROM memories ORDER BY id");
  return hash(result.rows);
}

after(async () => {
  await pool.end();
});

test("Phase 2 fix preflight preserves the current database baseline", async () => {
  assert.equal(process.env.TEST_NEON_PROJECT_ID, "odd-bread-81511600");
  assert.equal(process.env.TEST_NEON_BRANCH_ID, "br-lively-tree-bi1z37kh");
  assert.equal(process.env.DATABASE_URL, undefined);
  assert.equal(process.env.GROQ_API_KEY, undefined);
  assert.equal(process.env.TAVILY_API_KEY, undefined);

  baseline = await readPreservationState();
  assert.equal(baseline.users.length, 6);
  assert.deepEqual(
    baseline.users.map((row) => row.id).sort(),
    [...ORIGINAL_USER_IDS, USER_A, USER_B].sort()
  );
  assert.ok(baseline.conversations.length >= 5);
  assert.ok(baseline.memories.length >= 33);
  assert.ok(baseline.messages.length >= 1);
  assert.equal(baseline.sessions.length, 12);

  for (const user of baseline.users.filter((row) => ORIGINAL_USER_IDS.includes(row.id))) {
    assert.equal(hash(user), EXPECTED_ORIGINAL_USER_HASHES[user.id]);
  }

  for (const conversation of baseline.conversations.filter((row) => PHASE1_CONVERSATION_IDS.includes(row.id))) {
    assert.equal(hash(conversation), EXPECTED_PHASE1_CONVERSATION_HASHES[conversation.id]);
  }

  for (const memory of baseline.memories.filter((row) => PHASE1_MEMORY_IDS.includes(row.id))) {
    assert.equal(hash(memory), EXPECTED_PHASE1_MEMORY_HASHES[memory.id]);
  }

  const known = await pool.query(
    "SELECT * FROM memories WHERE id = ANY($1::uuid[]) ORDER BY id",
    [KNOWN_RECORD_IDS]
  );
  assert.equal(known.rowCount, 5);
  baseline.knownRecords = known.rows;

  console.log(JSON.stringify({
    check: "fix_regression_preflight",
    runId: RUN_ID,
    counts: await readCounts(),
    baselineMemoryHash: hash(baseline.memories),
    knownRecordIds: KNOWN_RECORD_IDS
  }));
});

test("Phase 2 fix create read update and repeated deactivate persist correctly", async () => {
  const created = await createMemory(USER_B, "fact", `I use PostgreSQL for ${RUN_ID} lifecycle.`, {
    importance: 4
  });
  assert.ok(created?.id);
  assert.equal((await getMemoryById(USER_B, created.id)).content, created.content);

  const updatedContent = `I use PostgreSQL for ${RUN_ID} lifecycle updated.`;
  const updated = await updateMemory(USER_B, created.id, updatedContent);
  assert.equal(updated.status, "updated");
  assert.equal((await readMemory(created.id)).content, updatedContent);

  const beforeRetry = await readMemory(created.id);
  const retry = await updateMemory(USER_B, created.id, updatedContent);
  assert.equal(retry.status, "updated");
  assert.equal(hash(await readMemory(created.id)), hash(beforeRetry));

  assert.equal(await deactivateMemory(USER_B, created.id), true);
  assert.equal((await readMemory(created.id)).is_active, false);
  assert.equal(await deactivateMemory(USER_B, created.id), true);
  assert.equal((await readMemory(created.id)).is_active, false);
});

test("Phase 2 fix duplicate creates reuse case and whitespace variants without merging unrelated content", async () => {
  const content = `I use Node.js for ${RUN_ID} duplicate.`;
  const first = await createMemory(USER_B, "fact", content);
  assert.ok(first?.id);

  const variants = [
    content.toLowerCase(),
    content.toUpperCase(),
    `  ${content.toLowerCase().replace(/\./g, " ")}  `
  ];

  for (const variant of variants) {
    const duplicate = await createMemory(USER_B, "fact", variant);
    assert.equal(duplicate?.id, first.id);
  }

  const normalized = await pool.query(
    `SELECT count(*)::int AS count
     FROM memories
     WHERE user_id = $1
       AND memory_type = 'fact'
       AND is_active = TRUE
       AND expires_at IS NULL
       AND trim(regexp_replace(lower(content), '[^a-z0-9]+', ' ', 'g')) = $2`,
    [USER_B, normalizeMemoryKey(content)]
  );
  assert.equal(normalized.rows[0].count, 1);

  const unrelated = await createMemory(USER_B, "fact", `I use Node.js for ${RUN_ID} unrelated.`);
  assert.ok(unrelated?.id);
  assert.notEqual(unrelated.id, first.id);

  console.log(JSON.stringify({
    check: "duplicate_normalization_fixed",
    runId: RUN_ID,
    reusedId: first.id,
    variantCount: variants.length,
    activeLogicalCount: normalized.rows[0].count,
    unrelatedId: unrelated.id
  }));
});

test("Phase 2 fix persisted attribution rejects mixed and ambiguous statements", async () => {
  const userFact = await createMemory(USER_B, "fact", `I prefer Node.js. ${RUN_ID} user`);
  const rahulFact = await createMemory(USER_B, "fact", `[about: Rahul] Rahul prefers Java. ${RUN_ID} rahul`);
  const brotherFact = await createMemory(USER_B, "fact", `[about: user's brother] Brother works with Java. ${RUN_ID} brother`);
  assert.ok(userFact?.id);
  assert.ok(rahulFact?.id);
  assert.ok(brotherFact?.id);
  assert.equal(analyzeMemoryAttribution((await readMemory(userFact.id)).content).subject, "user");
  assert.equal(analyzeMemoryAttribution((await readMemory(rahulFact.id)).content).subject, "rahul");
  assert.equal(analyzeMemoryAttribution((await readMemory(brotherFact.id)).content).subject, "user's brother");

  const rejected = [
    `He prefers Java. ${RUN_ID} ambiguous`,
    `I use C++, but Rahul uses Java. ${RUN_ID} mixed`,
    `Rahul uses Java and Anita uses Python. ${RUN_ID} multiple`
  ];

  for (const content of rejected) {
    assert.equal(await createMemory(USER_B, "fact", content), null);
    const result = await pool.query(
      "SELECT count(*)::int AS count FROM memories WHERE user_id = $1 AND content = $2",
      [USER_B, content]
    );
    assert.equal(result.rows[0].count, 0);
  }

  assert.equal(analyzeMemoryAttribution("My friend Rahul uses Python.").subject, "rahul");
  assert.equal(analyzeMemoryAttribution("My backend preference is Node.js.").subject, "user");
});

test("Phase 2 fix temporary permanent and expired identities remain separate", async () => {
  const token = `expiry${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const content = `I keep expiry context ${token} for ${RUN_ID}.`;
  const permanent = await createMemory(USER_B, "fact", content);
  const expired = await createMemory(USER_B, "fact", content, {
    expiresAt: new Date(Date.now() - 60_000).toISOString()
  });
  const future = await createMemory(USER_B, "fact", content, {
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString()
  });

  assert.ok(permanent?.id);
  assert.ok(expired?.id);
  assert.ok(future?.id);
  assert.notEqual(permanent.id, expired.id);
  assert.notEqual(permanent.id, future.id);
  assert.equal((await readMemory(expired.id)).is_active, true);

  const active = await getUserMemories(USER_B, 100);
  assert.ok(active.some((memory) => memory.id === permanent.id));
  assert.ok(active.some((memory) => memory.id === future.id));
  assert.equal(active.some((memory) => memory.id === expired.id), false);

  const relevant = await getRelevantMemories(USER_B, [token], 100);
  assert.ok(relevant.some((memory) => memory.id === permanent.id));
  assert.ok(relevant.some((memory) => memory.id === future.id));
  assert.equal(relevant.some((memory) => memory.id === expired.id), false);
});

test("Phase 2 fix supersede retry reuses the replacement and preserves history provenance and categories", async () => {
  const conversation = await createConversation(USER_B, `${RUN_ID} provenance conversation`);
  assert.ok(conversation?.id);
  const message = await createMessage(
    USER_B,
    conversation.id,
    "user",
    `${RUN_ID} provenance source message`
  );
  assert.ok(message?.id);

  const dsaSubject = `phase2dsa${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const frontendSubject = `phase2frontend${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const frontend = await createMemory(USER_B, "preference", `[about: ${frontendSubject}] Frontend preference is React. ${RUN_ID} frontend`, {
    sourceMessageId: message.id
  });
  assert.ok(frontend?.id);
  const frontendBefore = await readMemory(frontend.id);
  fixture = {
    conversationId: conversation.id,
    messageId: message.id,
    frontendId: frontend.id,
    dsaSubject,
    frontendSubject
  };

  const oldPrefix = `${RUN_ID} old dsa`;
  const old = await createMemory(USER_B, "preference", `[about: ${dsaSubject}] DSA preference is Node.js. ${oldPrefix}`, {
    confidence: 0.95,
    importance: 4,
    sourceMessageId: message.id
  });
  assert.ok(old?.id);

  const replacement = `[about: ${dsaSubject}] DSA preference is Python. ${RUN_ID} new dsa`;
  const plan = planMemoryActions(
    [{
      action: "update",
      replaces_id: old.id,
      subject: dsaSubject,
      memory_type: "preference",
      content: replacement,
      duration: "permanent",
      confidence: 0.96,
      importance: 4
    }],
    [old],
    [old]
  );
  assert.equal(plan[0].type, "supersede");

  const first = await supersedeMemory(USER_B, old.id, "preference", replacement, {
    confidence: 0.96,
    importance: 4,
    sourceMessageId: message.id
  });
  assert.equal(first.status, "superseded");
  assert.equal((await readMemory(old.id)).is_active, false);
  assert.equal((await readMemory(first.memory.id)).is_active, true);

  const beforeRetry = await memorySnapshot();
  const retry = await supersedeMemory(USER_B, old.id, "preference", replacement, {
    confidence: 0.96,
    importance: 4,
    sourceMessageId: message.id
  });
  assert.equal(retry.status, "superseded");
  assert.equal(retry.memory.id, first.memory.id);
  assert.equal(await memorySnapshot(), beforeRetry);

  const dsa = await activeCategoryPreferences(USER_B, "dsa", dsaSubject);
  assert.deepEqual(dsa.map((memory) => memory.id), [first.memory.id]);
  assert.equal(hash(await readMemory(frontend.id)), hash(frontendBefore));

  const history = await pool.query(
    "SELECT * FROM memories WHERE user_id = $1 AND memory_type = 'fact' AND content LIKE $2",
    [USER_B, `%Previous preference: DSA preference is Node.js. ${oldPrefix}%`]
  );
  assert.equal(history.rowCount, 1);
  assert.equal(history.rows[0].source_message_id, message.id);
  assert.equal(history.rows[0].confidence, old.confidence);
  assert.equal(history.rows[0].importance, old.importance);

  fixture = {
    ...fixture,
    oldId: old.id,
    replacementId: first.memory.id,
    historyId: history.rows[0].id
  };

  console.log(JSON.stringify({
    check: "repeated_supersede_fixed",
    runId: RUN_ID,
    oldId: old.id,
    replacementId: first.memory.id,
    retryStatus: retry.status,
    databaseUnchangedOnRetry: true,
    historyId: history.rows[0].id,
    activeDsaCount: dsa.length,
    frontendUnchanged: true
  }));
});

test("Phase 2 fix invalid supersede requests roll back without cross-category mutation", async () => {
  const temporary = await createMemory(USER_B, "fact", `I keep a temporary target for ${RUN_ID}.`, {
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString()
  });
  assert.ok(temporary?.id);
  const unrelatedSubject = `phase2unrelated${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const unrelated = await createMemory(USER_B, "preference", `[about: ${unrelatedSubject}] Frontend preference is Svelte. ${RUN_ID} unrelated category`, {
    sourceMessageId: fixture.messageId
  });
  assert.ok(unrelated?.id);
  const unrelatedBefore = await readMemory(unrelated.id);
  const before = await memorySnapshot();

  const unknown = await supersedeMemory(
    USER_B,
    randomUUID(),
    "fact",
    `I replace an unknown target for ${RUN_ID}.`
  );
  const incompatible = await supersedeMemory(
    USER_B,
    temporary.id,
    "fact",
    `I replace a temporary target for ${RUN_ID}.`
  );

  assert.equal(unknown.status, "invalid_target");
  assert.equal(incompatible.status, "incompatible_target");
  assert.equal(await memorySnapshot(), before);
  assert.equal(hash(await readMemory(unrelated.id)), hash(unrelatedBefore));
  assert.equal((await readMemory(unrelated.id)).is_active, true);
});

test("Phase 2 fix retrieval and cross-user repository operations remain isolated", async () => {
  const token = `retrieval${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const marker = await createMemory(USER_B, "fact", `I store retrieval marker ${token} for ${RUN_ID}.`, {
    importance: 5,
    sourceMessageId: fixture.messageId
  });
  assert.ok(marker?.id);

  const ownerContext = await retrieveMemoryContext(USER_B, token, []);
  const excludedContext = await retrieveMemoryContext(USER_B, token, [fixture.messageId]);
  const otherContext = await retrieveMemoryContext(USER_A, token, []);
  assert.ok(ownerContext.includes(token));
  assert.equal(excludedContext.includes(token), false);
  assert.equal(otherContext.includes(token), false);

  const before = await readMemory(marker.id);
  assert.equal(await getMemoryById(USER_A, marker.id), null);
  assert.equal((await updateMemory(USER_A, marker.id, "I change another user's memory.")).status, "not_found");
  assert.equal(await deactivateMemory(USER_A, marker.id), false);
  assert.equal((await supersedeMemory(USER_A, marker.id, "fact", "I replace this cross-user repository marker.")).status, "invalid_target");
  assert.equal(hash(await readMemory(marker.id)), hash(before));
});

test("Phase 2 fix final audit preserves every pre-existing row and known defect artifact", async () => {
  const current = await readPreservationState();
  const filterByIds = (rows, ids) => rows.filter((row) => ids.includes(row.id));
  const baselineUserIds = baseline.users.map((row) => row.id);
  const baselineConversationIds = baseline.conversations.map((row) => row.id);
  const baselineMemoryIds = baseline.memories.map((row) => row.id);
  const baselineMessageIds = baseline.messages.map((row) => row.id);
  const baselineSessionIds = baseline.sessions.map((row) => row.id);

  assert.equal(current.users.length, 6);
  assert.equal(hash(current.users), hash(baseline.users));
  assert.equal(hash(filterByIds(current.conversations, baselineConversationIds)), hash(baseline.conversations));
  assert.equal(hash(filterByIds(current.memories, baselineMemoryIds)), hash(baseline.memories));
  assert.equal(hash(filterByIds(current.messages, baselineMessageIds)), hash(baseline.messages));
  assert.equal(hash(filterByIds(current.sessions, baselineSessionIds)), hash(baseline.sessions));

  const known = await pool.query(
    "SELECT * FROM memories WHERE id = ANY($1::uuid[]) ORDER BY id",
    [KNOWN_RECORD_IDS]
  );
  assert.equal(hash(known.rows), hash(baseline.knownRecords));

  const sourceViolations = await pool.query(
    `SELECT count(*)::int AS count
     FROM memories m
     LEFT JOIN messages msg ON msg.id = m.source_message_id
     LEFT JOIN conversations c ON c.id = msg.conversation_id
     WHERE m.source_message_id IS NOT NULL
       AND (msg.id IS NULL OR c.user_id <> m.user_id)`
  );
  assert.equal(sourceViolations.rows[0].count, 0);

  const counts = await readCounts();
  assert.equal(counts.auth_users, 6);
  assert.equal(counts.reminders, 0);
  assert.equal(counts.agent_tool_logs, 0);
  assert.equal(counts.auth_sessions, 12);

  const runRows = await pool.query(
    "SELECT id, user_id, memory_type, content, is_active, source_message_id FROM memories WHERE content LIKE $1 ORDER BY id",
    [`%${RUN_ID}%`]
  );
  assert.ok(runRows.rows.every((row) => row.user_id === USER_B));

  console.log(JSON.stringify({
    check: "fix_regression_final_audit",
    runId: RUN_ID,
    counts,
    newRunMemoryCount: runRows.rows.length,
    newRunMemoryIds: runRows.rows.map((row) => row.id),
    fixture,
    sourceOwnershipViolations: sourceViolations.rows[0].count,
    preExistingRowsUnchanged: true,
    knownDuplicateAndMixedRecordsUnchanged: true,
    phase1RowsUnchanged: true
  }, null, 2));
});
