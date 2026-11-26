import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import pool from "../src/config/database.js";
import { validateIntegrationEnvironment } from "../src/config/integration-env.js";
import {
  createMemory,
  deactivateMemory,
  getRelevantMemories,
  getUserMemories,
  supersedeMemory,
  updateMemory
} from "../src/repositories/memory.repository.js";
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
const RUN_ID = manifest.runId;
const USER_A = manifest.userAId;
const USER_B = manifest.userBId;
const PROVENANCE_MESSAGE_ID = manifest.provenanceMessageId;
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

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
}

function prefix(label) {
  return `${RUN_ID} repository ${label} ${randomUUID()}`;
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

async function activePreferences(userId, category) {
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
    analyzeMemoryAttribution(memory.content).subject === "user" &&
    getPreferenceCategory(memory.content) === category
  );
}

async function snapshot() {
  const [conversations, memories, messages] = await Promise.all([
    pool.query("SELECT * FROM conversations ORDER BY id"),
    pool.query("SELECT * FROM memories ORDER BY id"),
    pool.query("SELECT * FROM messages ORDER BY id")
  ]);

  return hash({ conversations: conversations.rows, memories: memories.rows, messages: messages.rows });
}

after(async () => {
  await pool.end();
});

test("Phase 2 repository preflight preserves six users and Phase 1 rows", async () => {
  assert.equal(process.env.TEST_NEON_PROJECT_ID, "odd-bread-81511600");
  assert.equal(process.env.TEST_NEON_BRANCH_ID, "br-lively-tree-bi1z37kh");
  assert.equal(process.env.DATABASE_URL, undefined);
  assert.equal(process.env.GROQ_API_KEY, undefined);
  assert.equal(process.env.TAVILY_API_KEY, undefined);

  const users = await readAuthUserVerificationRows(pool, ORIGINAL_USER_IDS);
  for (const user of users) {
    assert.equal(hash(user), EXPECTED_ORIGINAL_USER_HASHES[user.id]);
  }

  const allUsers = await pool.query('SELECT id FROM neon_auth."user" ORDER BY id');
  assert.deepEqual(
    allUsers.rows.map((row) => row.id).sort(),
    [...ORIGINAL_USER_IDS, USER_A, USER_B].sort()
  );

  const conversations = await pool.query("SELECT * FROM conversations ORDER BY id");
  const memories = await pool.query("SELECT * FROM memories ORDER BY id");
  const phase1Conversations = conversations.rows.filter((row) => PHASE1_CONVERSATION_IDS.includes(row.id));
  const phase1Memories = memories.rows.filter((row) => PHASE1_MEMORY_IDS.includes(row.id));
  assert.equal(phase1Conversations.length, 2);
  assert.equal(phase1Memories.length, 2);
  for (const conversation of phase1Conversations) {
    assert.equal(hash(conversation), EXPECTED_PHASE1_CONVERSATION_HASHES[conversation.id]);
  }
  for (const memory of phase1Memories) {
    assert.equal(hash(memory), EXPECTED_PHASE1_MEMORY_HASHES[memory.id]);
  }

  const originalSessions = await pool.query(
    `SELECT count(*)::int AS count
     FROM neon_auth.session
     WHERE "userId" = ANY($1::uuid[])`,
    [ORIGINAL_USER_IDS]
  );
  assert.equal(originalSessions.rows[0].count, 8);
});

test("Phase 2 repository duplicate create is idempotent", async () => {
  const content = `Repository Duplicate Probe ${prefix("duplicate")}`;
  const first = await createMemory(USER_A, "fact", content);
  const second = await createMemory(USER_A, "fact", content);
  assert.ok(first?.id);
  assert.ok(second?.id);
  console.log(JSON.stringify({
    check: "duplicate_create",
    firstId: first.id,
    secondId: second.id,
    sameId: first.id === second.id
  }));
  assert.equal(second.id, first.id);
});

test("Phase 2 repository update and repeated deactivate persist correctly", async () => {
  const content = `Repository Lifecycle ${prefix("lifecycle")}`;
  const created = await createMemory(USER_A, "fact", content, { importance: 4 });
  assert.ok(created?.id);
  const updatedContent = `I updated my repository lifecycle. ${prefix("updated")}`;
  const updated = await updateMemory(USER_A, created.id, updatedContent);
  assert.equal(updated.status, "updated");
  assert.equal((await readMemory(created.id)).content, updatedContent);

  const beforeRetry = await readMemory(created.id);
  const retry = await updateMemory(USER_A, created.id, updatedContent);
  assert.equal(retry.status, "updated");
  assert.equal(hash(await readMemory(created.id)), hash(beforeRetry));

  assert.equal(await deactivateMemory(USER_A, created.id), true);
  const afterFirstDelete = await readMemory(created.id);
  assert.equal(afterFirstDelete.is_active, false);
  assert.equal(await deactivateMemory(USER_A, created.id), true);
  const afterSecondDelete = await readMemory(created.id);
  assert.equal(afterSecondDelete.is_active, false);
  assert.notEqual(afterSecondDelete.updated_at.toISOString(), afterFirstDelete.updated_at.toISOString());
});

test("Phase 2 repository attribution separates user, named person, relative, and ambiguous content", async () => {
  const userFact = await createMemory(USER_A, "fact", `I prefer Node.js. ${prefix("user")}`);
  const rahulFact = await createMemory(USER_A, "fact", `[about: Rahul] Rahul prefers Java. ${prefix("rahul")}`);
  const brotherFact = await createMemory(USER_A, "fact", `[about: user's brother] Brother works with Java. ${prefix("brother")}`);
  const ambiguous = await createMemory(USER_A, "fact", `He prefers Java. ${prefix("ambiguous")}`);
  const mixed = await createMemory(USER_A, "fact", `I use C++, but Rahul uses Java. ${prefix("mixed")}`);

  assert.ok(userFact?.id);
  assert.ok(rahulFact?.id);
  assert.ok(brotherFact?.id);
  assert.equal(ambiguous, null);
  assert.equal(mixed, null);
  assert.equal(analyzeMemoryAttribution((await readMemory(userFact.id)).content).subject, "user");
  assert.equal(analyzeMemoryAttribution((await readMemory(rahulFact.id)).content).subject, "rahul");
  assert.equal(analyzeMemoryAttribution((await readMemory(brotherFact.id)).content).subject, "user's brother");
});

test("Phase 2 repository temporary and permanent identities remain separate", async () => {
  const token = `expiryprobe${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const content = `Repository Expiry ${token} ${prefix("expiry")}`;
  const permanent = await createMemory(USER_A, "fact", content);
  const expired = await createMemory(USER_A, "fact", content, {
    expiresAt: new Date(Date.now() - 60_000).toISOString()
  });
  const future = await createMemory(USER_A, "fact", content, {
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString()
  });

  assert.ok(permanent?.id);
  assert.ok(expired?.id);
  assert.ok(future?.id);
  assert.notEqual(permanent.id, expired.id);
  assert.notEqual(permanent.id, future.id);
  assert.equal((await readMemory(expired.id)).is_active, true);

  const active = await getUserMemories(USER_A, 100);
  assert.ok(active.some((memory) => memory.id === permanent.id));
  assert.ok(active.some((memory) => memory.id === future.id));
  assert.equal(active.some((memory) => memory.id === expired.id), false);
  const relevant = await getRelevantMemories(USER_A, [token], 100);
  assert.ok(relevant.some((memory) => memory.id === permanent.id));
  assert.ok(relevant.some((memory) => memory.id === future.id));
  assert.equal(relevant.some((memory) => memory.id === expired.id), false);
});

test("Phase 2 repository supersede preserves history and provenance", async () => {
  const oldPrefix = prefix("old-backend");
  const old = await createMemory(USER_A, "preference", `My backend preference is Node.js. ${oldPrefix}`, {
    confidence: 0.95,
    importance: 4,
    sourceMessageId: PROVENANCE_MESSAGE_ID
  });
  assert.ok(old?.id);
  const plan = planMemoryActions(
    [{
      action: "update",
      replaces_id: old.id,
      subject: "user",
      memory_type: "preference",
      content: `My backend preference is Python. ${prefix("new-backend")}`,
      duration: "permanent",
      confidence: 0.96,
      importance: 4
    }],
    [old],
    [old]
  );
  assert.equal(plan[0].type, "supersede");
  const result = await supersedeMemory(USER_A, old.id, "preference", plan[0].memory.content, {
    confidence: 0.96,
    importance: 4,
    sourceMessageId: PROVENANCE_MESSAGE_ID
  });
  assert.equal(result.status, "superseded");
  assert.equal((await readMemory(old.id)).is_active, false);
  assert.equal((await readMemory(result.memory.id)).is_active, true);

  const history = await pool.query(
    "SELECT * FROM memories WHERE user_id = $1 AND memory_type = 'fact' AND content LIKE $2",
    [USER_A, `Previous preference: My backend preference is Node.js. ${oldPrefix}%`]
  );
  assert.equal(history.rowCount, 1);
  assert.equal(history.rows[0].source_message_id, PROVENANCE_MESSAGE_ID);
  assert.equal(history.rows[0].confidence, old.confidence);
  assert.equal(history.rows[0].importance, old.importance);
});

test("Phase 2 repository repeated supersede remains idempotent", async () => {
  const old = await createMemory(USER_A, "preference", `My backend preference is Kotlin. ${prefix("repeat-old")}`, {
    confidence: 0.95,
    importance: 4,
    sourceMessageId: PROVENANCE_MESSAGE_ID
  });
  assert.ok(old?.id);
  const replacement = `My backend preference is Ruby. ${prefix("repeat-new")}`;
  const first = await supersedeMemory(USER_A, old.id, "preference", replacement, {
    confidence: 0.96,
    importance: 4,
    sourceMessageId: PROVENANCE_MESSAGE_ID
  });
  assert.equal(first.status, "superseded");
  const beforeRetry = await snapshot();
  const retry = await supersedeMemory(USER_A, old.id, "preference", replacement, {
    confidence: 0.96,
    importance: 4,
    sourceMessageId: PROVENANCE_MESSAGE_ID
  });
  console.log(JSON.stringify({
    check: "repeated_supersede",
    firstStatus: first.status,
    retryStatus: retry.status,
    databaseUnchanged: beforeRetry === await snapshot()
  }));
  assert.equal(retry.status, "superseded");
  assert.equal(retry.memory.id, first.memory.id);
  assert.equal(await snapshot(), beforeRetry);
});

test("Phase 2 repository later category winner preserves prior history", async () => {
  const winner = await createMemory(USER_A, "preference", `My backend preference is Rust. ${prefix("winner")}`, {
    confidence: 0.97,
    importance: 4,
    sourceMessageId: PROVENANCE_MESSAGE_ID
  });
  assert.ok(winner?.id);
  const backend = await activePreferences(USER_A, "backend");
  assert.deepEqual(backend.map((memory) => memory.id), [winner.id]);
  const history = await pool.query(
    `SELECT * FROM memories
     WHERE user_id = $1
       AND memory_type = 'fact'
       AND content LIKE $2`,
    [USER_A, `Previous preference:%${RUN_ID}%`]
  );
  assert.ok(history.rowCount >= 3);
  assert.ok(history.rows.every((memory) => memory.source_message_id === PROVENANCE_MESSAGE_ID));
});

test("Phase 2 repository frontend update preserves historical preference", async () => {
  const oldPrefix = prefix("frontend-old");
  const newPrefix = prefix("frontend-new");
  const created = await createMemory(USER_A, "preference", `My frontend preference is React. ${oldPrefix}`, {
    sourceMessageId: PROVENANCE_MESSAGE_ID
  });
  assert.ok(created?.id);
  const updated = await updateMemory(USER_A, created.id, `My frontend preference is Vue. ${newPrefix}`);
  assert.equal(updated.status, "updated");
  assert.equal((await readMemory(created.id)).content, `My frontend preference is Vue. ${newPrefix}`);
  const frontend = await activePreferences(USER_A, "frontend");
  assert.deepEqual(frontend.map((memory) => memory.id), [created.id]);
  const history = await pool.query(
    "SELECT * FROM memories WHERE user_id = $1 AND content LIKE $2",
    [USER_A, `Previous preference: My frontend preference is React. ${oldPrefix}%`]
  );
  assert.equal(history.rowCount, 1);
  assert.equal(history.rows[0].source_message_id, PROVENANCE_MESSAGE_ID);
});

test("Phase 2 repository invalid supersede requests insert nothing", async () => {
  const temporary = await createMemory(USER_A, "fact", `Repository Temporary Target ${prefix("invalid-target")}`, {
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString()
  });
  assert.ok(temporary?.id);
  const before = await snapshot();
  const unknown = await supersedeMemory(USER_A, randomUUID(), "fact", `Repository Unknown Target ${prefix("unknown")}`);
  const incompatible = await supersedeMemory(USER_A, temporary.id, "fact", `Repository Incompatible Target ${prefix("incompatible")}`);
  assert.equal(unknown.status, "invalid_target");
  assert.equal(incompatible.status, "incompatible_target");
  assert.equal(await snapshot(), before);
});

test("Phase 2 repository retrieval crosses conversations but not users", async () => {
  const token = `retrievalprobe${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const marker = await createMemory(USER_A, "fact", `Repository Retrieval ${token} ${prefix("retrieval")}`, {
    importance: 5,
    sourceMessageId: PROVENANCE_MESSAGE_ID
  });
  assert.ok(marker?.id);
  const ownerContext = await retrieveMemoryContext(USER_A, token, []);
  const excludedContext = await retrieveMemoryContext(USER_A, token, [PROVENANCE_MESSAGE_ID]);
  const otherContext = await retrieveMemoryContext(USER_B, token, []);
  assert.ok(ownerContext.includes(token));
  assert.equal(excludedContext.includes(token), false);
  assert.equal(otherContext.includes(token), false);
});

test("Phase 2 repository final audit preserves production and Phase 1 boundaries", async () => {
  const users = await readAuthUserVerificationRows(pool, ORIGINAL_USER_IDS);
  for (const user of users) {
    assert.equal(hash(user), EXPECTED_ORIGINAL_USER_HASHES[user.id]);
  }

  const allUsers = await pool.query('SELECT id FROM neon_auth."user" ORDER BY id');
  assert.equal(allUsers.rowCount, 6);
  const conversations = await pool.query("SELECT * FROM conversations ORDER BY id");
  const memories = await pool.query("SELECT * FROM memories ORDER BY id");
  const messages = await pool.query("SELECT * FROM messages ORDER BY id");
  const counts = await readCounts();
  assert.equal(counts.conversations, 5);
  assert.equal(counts.messages, 1);
  assert.equal(counts.reminders, 0);
  assert.equal(counts.agent_tool_logs, 0);
  assert.ok(counts.auth_sessions >= 12);

  const phase1Conversations = conversations.rows.filter((row) => PHASE1_CONVERSATION_IDS.includes(row.id));
  const phase1Memories = memories.rows.filter((row) => PHASE1_MEMORY_IDS.includes(row.id));
  assert.equal(phase1Conversations.length, 2);
  assert.equal(phase1Memories.length, 2);
  for (const conversation of phase1Conversations) {
    assert.equal(hash(conversation), EXPECTED_PHASE1_CONVERSATION_HASHES[conversation.id]);
  }
  for (const memory of phase1Memories) {
    assert.equal(hash(memory), EXPECTED_PHASE1_MEMORY_HASHES[memory.id]);
  }

  const phase2Memories = memories.rows.filter((row) => row.user_id === USER_A || row.user_id === USER_B);
  assert.ok(phase2Memories.every((memory) => memory.content.includes(RUN_ID)));
  assert.equal(messages.rowCount, 1);
  assert.equal(messages.rows[0].metadata?.status, "failed");

  const sourceViolations = await pool.query(
    `SELECT count(*)::int AS count
     FROM memories m
     LEFT JOIN messages msg ON msg.id = m.source_message_id
     LEFT JOIN conversations c ON c.id = msg.conversation_id
     WHERE m.user_id = ANY($1::uuid[])
       AND m.source_message_id IS NOT NULL
       AND (msg.id IS NULL OR c.user_id <> m.user_id)`,
    [[USER_A, USER_B]]
  );
  assert.equal(sourceViolations.rows[0].count, 0);
  assert.equal((await activePreferences(USER_A, "backend")).length, 1);
  assert.equal((await activePreferences(USER_A, "frontend")).length, 1);

  console.log(JSON.stringify({
    check: "final_repository_audit",
    userAId: USER_A,
    userBId: USER_B,
    counts,
    phase2Memories: phase2Memories.length,
    sourceOwnershipViolations: sourceViolations.rows[0].count,
    phase1RowsUnchanged: true,
    originalUsersUnchanged: true
  }, null, 2));
});
