import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";

import app from "../src/app.js";
import pool from "../src/config/database.js";
import { validateIntegrationEnvironment } from "../src/config/integration-env.js";
import {
  getRelevantMemories,
  supersedeMemory
} from "../src/repositories/memory.repository.js";
import { retrieveMemoryContext } from "../src/services/agent.service.js";
import {
  analyzeMemoryAttribution,
  getPreferenceCategory,
  planMemoryActions
} from "../src/utils/memory-format.js";
import { readAuthUserVerificationRows } from "./phase1-auth.helpers.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_FILE = path.join(TEST_DIR, "../phase2-identities.integration.local.json");
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

if (process.env.INTEGRATION_MODE !== "true") {
  throw new Error("Approved isolated integration mode is required.");
}

validateIntegrationEnvironment();

const AUTH_BASE_URL = process.env.TEST_NEON_AUTH_URL.replace(/\/+$/, "");
const AUTH_ORIGIN = process.env.TEST_AUTH_ORIGIN;
const ISSUER = new URL(process.env.NEON_AUTH_BASE_URL).origin;
const JWKS = createRemoteJWKSet(new URL(process.env.NEON_AUTH_JWKS_URL));
const RUN_ID = `phase2-${randomUUID()}`;
const PREFIX = `Minimi Phase2 ${RUN_ID}`;
const state = {
  baseline: null,
  userA: null,
  userB: null,
  conversationA1: null,
  conversationA2: null,
  conversationB1: null,
  provenanceMessageId: null,
  memoryIds: new Set(),
  checks: []
};

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
}

function recordCheck(name, evidence, details = {}) {
  state.checks.push({ name, evidence, ...details });
  console.log(`[phase2] ${name}: verified`);
}

function saveManifest() {
  writeFileSync(MANIFEST_FILE, `${JSON.stringify({
    projectId: process.env.TEST_NEON_PROJECT_ID,
    branchId: process.env.TEST_NEON_BRANCH_ID,
    endpoint: "ep-rough-king-bi6v85y5",
    runId: RUN_ID,
    userAId: state.userA?.id,
    userBId: state.userB?.id,
    conversationA1Id: state.conversationA1?.id,
    conversationA2Id: state.conversationA2?.id,
    conversationB1Id: state.conversationB1?.id,
    provenanceMessageId: state.provenanceMessageId,
    memoryIds: [...state.memoryIds],
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`);
}

async function authRequest(suffix, { method = "GET", body, cookie } = {}) {
  const headers = {
    Accept: "application/json",
    Origin: AUTH_ORIGIN
  };

  if (body) {
    headers["Content-Type"] = "application/json";
  }

  if (cookie) {
    headers.Cookie = cookie;
  }

  const response = await fetch(`${AUTH_BASE_URL}${suffix}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const cookies = response.headers.getSetCookie();
  const sessionCookie = cookies.length
    ? cookies.map((value) => value.split(";")[0]).join("; ")
    : null;

  return { response, sessionCookie };
}

async function requireAuthResponse(suffix, options, expectedStatus, label) {
  const { response, sessionCookie } = await authRequest(suffix, options);
  assert.equal(response.status, expectedStatus, `${label} returned HTTP ${response.status}`);
  return { response, sessionCookie };
}

async function issueAndVerifyToken(user, cookie, label) {
  const { response } = await requireAuthResponse("/token", { cookie }, 200, `${label}_token`);
  const data = await response.json();
  assert.equal(typeof data.token, "string");
  assert.ok(data.token.length > 0);

  const { payload } = await jwtVerify(data.token, JWKS, {
    issuer: ISSUER,
    audience: ISSUER
  });
  const decoded = decodeJwt(data.token);
  assert.equal(payload.sub, user.id);
  assert.equal(payload.iss, ISSUER);
  assert.equal(payload.aud, ISSUER);
  assert.equal(typeof decoded.exp, "number");
  assert.ok(decoded.exp > Math.floor(Date.now() / 1000));

  return data.token;
}

async function createSyntheticUser(label) {
  const email = `minimi-${RUN_ID}-${label.toLowerCase()}@example.com`;
  const password = `${randomBytes(24).toString("base64url")}Aa1!`;
  const name = `Minimi ${RUN_ID} User ${label}`;

  const signup = await requireAuthResponse(
    "/sign-up/email",
    { method: "POST", body: { name, email, password } },
    200,
    `${label}_signup`
  );
  const signupData = await signup.response.json();
  assert.equal(typeof signupData.user?.id, "string");
  assert.ok(signupData.user.id);
  assert.equal(signupData.user.email, email);

  const signin = await requireAuthResponse(
    "/sign-in/email",
    { method: "POST", body: { email, password } },
    200,
    `${label}_signin`
  );
  const signinData = await signin.response.json();
  assert.equal(signinData.user?.id, signupData.user.id);
  assert.ok(signin.sessionCookie);

  const token = await issueAndVerifyToken(signupData.user, signin.sessionCookie, label);
  return { id: signupData.user.id, token };
}

async function apiRequest(apiOrigin, route, { method = "GET", token, body } = {}) {
  const headers = { Accept: "application/json" };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (body) {
    headers["Content-Type"] = "application/json";
  }

  return fetch(`${apiOrigin}/api${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
}

async function readAuditState() {
  const [conversations, memories, messages] = await Promise.all([
    pool.query("SELECT * FROM conversations ORDER BY id"),
    pool.query("SELECT * FROM memories ORDER BY id"),
    pool.query("SELECT * FROM messages ORDER BY id")
  ]);

  return {
    conversations: conversations.rows,
    memories: memories.rows,
    messages: messages.rows
  };
}

async function auditedApiRequest(
  name,
  apiOrigin,
  route,
  options,
  expectedStatus,
  expectedDatabaseChange
) {
  const before = await readAuditState();
  const response = await apiRequest(apiOrigin, route, options);
  const after = await readAuditState();
  const databaseChanged = hash(before) !== hash(after);

  state.checks.push({
    name,
    evidence: "real_http_and_postgresql",
    httpStatus: response.status,
    databaseChanged
  });
  console.log(`[phase2] ${name}: HTTP ${response.status}; database_changed=${databaseChanged}`);
  assert.equal(response.status, expectedStatus, `${name} returned HTTP ${response.status}`);
  assert.equal(databaseChanged, expectedDatabaseChange, `${name} database-change mismatch`);

  return response;
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

async function readOriginalSessions() {
  const result = await pool.query(
    `SELECT id, "userId", "expiresAt", "createdAt", "updatedAt"
     FROM neon_auth.session
     WHERE "userId" = ANY($1::uuid[])
     ORDER BY id`,
    [ORIGINAL_USER_IDS]
  );

  return result.rows;
}

async function preflight() {
  assert.equal(process.env.TEST_NEON_PROJECT_ID, "odd-bread-81511600");
  assert.equal(process.env.TEST_NEON_BRANCH_ID, "br-lively-tree-bi1z37kh");
  assert.equal(process.env.DATABASE_URL, undefined);
  assert.equal(process.env.GROQ_API_KEY, undefined);
  assert.equal(process.env.TAVILY_API_KEY, undefined);
  assert.equal(process.env.TEST_CONVERSATION_ID, undefined);
  assert.equal(process.env.TEST_MEMORY_ID, undefined);

  const dbUrl = new URL(process.env.DATABASE_URL_POOLED);
  const authUrl = new URL(process.env.NEON_AUTH_BASE_URL);
  const jwksUrl = new URL(process.env.NEON_AUTH_JWKS_URL);
  const endpoint = dbUrl.hostname.split(".")[0].replace(/-pooler$/, "");
  assert.equal(endpoint, "ep-rough-king-bi6v85y5");
  assert.equal(authUrl.hostname.split(".")[0], endpoint);
  assert.equal(jwksUrl.hostname.split(".")[0], endpoint);

  const integrationValues = Object.entries(process.env)
    .filter(([key]) => key.startsWith("TEST_") ||
      key === "DATABASE_URL_POOLED" ||
      key === "NEON_AUTH_BASE_URL" ||
      key === "NEON_AUTH_JWKS_URL")
    .map(([, value]) => String(value));

  for (const forbidden of ["winter-math-54988029", "br-restless-silence-ao5ra3rh", "ep-calm-violet-aophputx"]) {
    assert.equal(integrationValues.some((value) => value.includes(forbidden)), false);
  }

  const jwksResponse = await fetch(process.env.NEON_AUTH_JWKS_URL);
  assert.equal(jwksResponse.status, 200);
  const jwks = await jwksResponse.json();
  assert.equal(jwks.keys.length, 1);

  const users = await readAuthUserVerificationRows(pool, ORIGINAL_USER_IDS);
  assert.deepEqual(users.map((row) => row.id).sort(), [...ORIGINAL_USER_IDS].sort());
  const sessions = await readOriginalSessions();
  const conversations = await pool.query("SELECT * FROM conversations ORDER BY id");
  const memories = await pool.query("SELECT * FROM memories ORDER BY id");
  const counts = await readCounts();

  assert.deepEqual(conversations.rows.map((row) => row.id).sort(), [...PHASE1_CONVERSATION_IDS].sort());
  assert.deepEqual(memories.rows.map((row) => row.id).sort(), [...PHASE1_MEMORY_IDS].sort());
  assert.deepEqual(counts, {
    auth_users: 4,
    conversations: 2,
    memories: 2,
    active_memories: 2,
    messages: 0,
    reminders: 0,
    agent_tool_logs: 0,
    auth_sessions: 8
  });

  const tables = await pool.query(
    `SELECT count(*)::int AS count
     FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = ANY($2)`,
    ["public", ["conversations", "messages", "memories", "reminders", "agent_tool_logs"]]
  );
  assert.equal(tables.rows[0].count, 5);

  const foreignKeys = await pool.query(
    `SELECT count(*)::int AS count
     FROM pg_constraint
     WHERE contype = $1
       AND confrelid = $2::regclass
       AND connamespace = $3::regnamespace`,
    ["f", "neon_auth.\"user\"", "public"]
  );
  assert.equal(foreignKeys.rows[0].count, 4);

  state.baseline = {
    users,
    sessions,
    conversations: conversations.rows,
    memories: memories.rows,
    counts
  };
  recordCheck("isolation_preflight", "real_postgresql", {
    projectId: process.env.TEST_NEON_PROJECT_ID,
    branchId: process.env.TEST_NEON_BRANCH_ID,
    endpoint,
    jwksKeyCount: jwks.keys.length,
    counts
  });
}

async function createConversation(apiOrigin, name, token, title) {
  const response = await auditedApiRequest(
    name,
    apiOrigin,
    "/conversations",
    { method: "POST", token, body: { title } },
    201,
    true
  );
  const data = await response.json();
  assert.equal(data.success, true);
  assert.equal(typeof data.conversation?.id, "string");
  return data.conversation;
}

async function createMemory(
  apiOrigin,
  name,
  token,
  body,
  expectedStatus = 201,
  expectedDatabaseChange = true
) {
  const response = await auditedApiRequest(
    name,
    apiOrigin,
    "/memories",
    { method: "POST", token, body },
    expectedStatus,
    expectedDatabaseChange
  );
  const data = await response.json();

  if (data.memory?.id) {
    state.memoryIds.add(data.memory.id);
  }

  return data.memory;
}

async function readMemory(memoryId) {
  const result = await pool.query("SELECT * FROM memories WHERE id = $1", [memoryId]);
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function listMemories(apiOrigin, name, token) {
  const response = await auditedApiRequest(name, apiOrigin, "/memories", { token }, 200, false);
  const data = await response.json();
  assert.equal(data.success, true);
  assert.ok(Array.isArray(data.memories));
  return data.memories;
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

async function finalAudit() {
  const finalOriginalUsers = await readAuthUserVerificationRows(pool, ORIGINAL_USER_IDS);
  const finalOriginalSessions = await readOriginalSessions();
  const allUsers = await pool.query('SELECT id FROM neon_auth."user" ORDER BY id');
  const allConversations = await pool.query("SELECT * FROM conversations ORDER BY id");
  const allMemories = await pool.query("SELECT * FROM memories ORDER BY id");
  const allMessages = await pool.query("SELECT * FROM messages ORDER BY id");
  const counts = await readCounts();
  const newUserIds = [state.userA.id, state.userB.id];

  assert.equal(counts.auth_users, 6);
  assert.deepEqual(
    allUsers.rows.map((row) => row.id).sort(),
    [...ORIGINAL_USER_IDS, ...newUserIds].sort()
  );
  assert.equal(hash(finalOriginalUsers), hash(state.baseline.users));
  assert.equal(hash(finalOriginalSessions), hash(state.baseline.sessions));

  const finalPhase1Conversations = allConversations.rows.filter((row) => PHASE1_CONVERSATION_IDS.includes(row.id));
  const finalPhase1Memories = allMemories.rows.filter((row) => PHASE1_MEMORY_IDS.includes(row.id));
  assert.equal(hash(finalPhase1Conversations), hash(state.baseline.conversations));
  assert.equal(hash(finalPhase1Memories), hash(state.baseline.memories));

  assert.equal(counts.conversations, 5);
  assert.equal(counts.messages, 1);
  assert.equal(counts.reminders, 0);
  assert.equal(counts.agent_tool_logs, 0);
  assert.ok(counts.auth_sessions >= 12);

  const phase2Conversations = allConversations.rows.filter((row) => newUserIds.includes(row.user_id));
  const phase2Memories = allMemories.rows.filter((row) => newUserIds.includes(row.user_id));
  assert.equal(phase2Conversations.length, 3);
  assert.ok(phase2Conversations.every((row) => row.title.includes(RUN_ID)));
  assert.ok(phase2Memories.length > 0);
  assert.ok(phase2Memories.every((row) => row.content.includes(RUN_ID)));
  assert.equal(
    allConversations.rows.filter((row) => ORIGINAL_USER_IDS.includes(row.user_id) && row.title.includes(RUN_ID)).length,
    0
  );
  assert.equal(
    allMemories.rows.filter((row) => ORIGINAL_USER_IDS.includes(row.user_id) && row.content.includes(RUN_ID)).length,
    0
  );

  assert.equal(allMessages.rowCount, 1);
  assert.equal(allMessages.rows[0].role, "user");
  assert.equal(allMessages.rows[0].metadata?.status, "failed");
  assert.ok(allMessages.rows[0].content.includes(RUN_ID));

  const sourceViolations = await pool.query(
    `SELECT count(*)::int AS count
     FROM memories m
     LEFT JOIN messages msg ON msg.id = m.source_message_id
     LEFT JOIN conversations c ON c.id = msg.conversation_id
     WHERE m.user_id = ANY($1::uuid[])
       AND m.source_message_id IS NOT NULL
       AND (msg.id IS NULL OR c.user_id <> m.user_id)`,
    [newUserIds]
  );
  assert.equal(sourceViolations.rows[0].count, 0);

  const backend = await activePreferences(state.userA.id, "backend");
  const frontend = await activePreferences(state.userA.id, "frontend");
  assert.equal(backend.length, 1);
  assert.equal(frontend.length, 1);
  assert.match(backend[0].content, /Rust/);
  assert.match(frontend[0].content, /Vue/);

  const summary = {
    runId: RUN_ID,
    userAId: state.userA.id,
    userBId: state.userB.id,
    counts,
    phase2Conversations: phase2Conversations.length,
    phase2Memories: phase2Memories.length,
    phase2Messages: allMessages.rowCount,
    sourceOwnershipViolations: sourceViolations.rows[0].count,
    originalUserHashesUnchanged: true,
    originalSessionHashesUnchanged: true,
    phase1RowHashesUnchanged: true,
    realLlmExtraction: "BLOCKED",
    checks: state.checks.length
  };

  saveManifest();
  recordCheck("final_database_audit", "real_postgresql", summary);
  console.log(JSON.stringify({ phase2Summary: summary }, null, 2));
}

test("Phase 2 real Neon memory lifecycle", async () => {
  await preflight();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiOrigin = `http://127.0.0.1:${server.address().port}`;

  try {
    state.userA = await createSyntheticUser("A");
    saveManifest();
    recordCheck("auth_user_a", "real_auth", { userId: state.userA.id });
    console.log(`[phase2] user_a_id=${state.userA.id}`);

    state.userB = await createSyntheticUser("B");
    saveManifest();
    recordCheck("auth_user_b", "real_auth", { userId: state.userB.id });
    console.log(`[phase2] user_b_id=${state.userB.id}`);

    const authUsers = await pool.query('SELECT id FROM neon_auth."user" ORDER BY id');
    assert.equal(authUsers.rowCount, 6);
    assert.equal(authUsers.rows.some((row) => ORIGINAL_USER_IDS.includes(row.id)), true);
    recordCheck("auth_jwks_verification", "real_auth", {
      issuerVerified: true,
      audienceVerified: true,
      expirationVerified: true,
      subjectVerified: true
    });

    state.conversationA1 = await createConversation(
      apiOrigin,
      "create_owner_conversation_a1",
      state.userA.token,
      `${PREFIX} owner primary`
    );
    state.conversationA2 = await createConversation(
      apiOrigin,
      "create_owner_conversation_a2",
      state.userA.token,
      `${PREFIX} owner retrieval`
    );
    state.conversationB1 = await createConversation(
      apiOrigin,
      "create_isolation_conversation_b1",
      state.userB.token,
      `${PREFIX} isolation`
    );
    saveManifest();

    const memoriesBeforeLlmProbe = (await readAuditState()).memories;
    const llmResponse = await auditedApiRequest(
      "llm_pipeline_without_groq",
      apiOrigin,
      `/messages/${state.conversationA1.id}`,
      {
        method: "POST",
        token: state.userA.token,
        body: { content: `${PREFIX} provenance source message` }
      },
      503,
      true
    );
    const llmData = await llmResponse.json();
    assert.equal(llmData.success, false);
    const memoriesAfterLlmProbe = (await readAuditState()).memories;
    assert.equal(hash(memoriesAfterLlmProbe), hash(memoriesBeforeLlmProbe));
    const provenanceMessages = await pool.query(
      "SELECT * FROM messages WHERE content = $1",
      [`${PREFIX} provenance source message`]
    );
    assert.equal(provenanceMessages.rowCount, 1);
    assert.equal(provenanceMessages.rows[0].role, "user");
    assert.equal(provenanceMessages.rows[0].metadata?.status, "failed");
    state.provenanceMessageId = provenanceMessages.rows[0].id;
    recordCheck("llm_extraction_blocked", "real_http_and_postgresql", {
      httpStatus: 503,
      memoriesCreated: 0,
      failedUserMessagesCreated: 1
    });
    saveManifest();

    const factContent = `${PREFIX} permanent lifecycle fact`;
    const lifecycleFact = await createMemory(apiOrigin, "create_permanent_fact", state.userA.token, {
      memoryType: "fact",
      content: factContent,
      confidence: 0.9,
      importance: 4
    });
    let row = await readMemory(lifecycleFact.id);
    assert.equal(row.user_id, state.userA.id);
    assert.equal(row.content, factContent);
    assert.equal(row.is_active, true);
    assert.equal(row.expires_at, null);

    let listed = await listMemories(apiOrigin, "list_after_create", state.userA.token);
    assert.ok(listed.some((memory) => memory.id === lifecycleFact.id));

    const updatedFactContent = `${PREFIX} updated permanent lifecycle fact`;
    const patchResponse = await auditedApiRequest(
      "update_permanent_fact",
      apiOrigin,
      `/memories/${lifecycleFact.id}`,
      { method: "PATCH", token: state.userA.token, body: { content: updatedFactContent } },
      200,
      true
    );
    const patchData = await patchResponse.json();
    assert.equal(patchData.memory.content, updatedFactContent);
    row = await readMemory(lifecycleFact.id);
    assert.equal(row.content, updatedFactContent);

    const beforeIdempotentPatch = await readMemory(lifecycleFact.id);
    await auditedApiRequest(
      "idempotent_same_content_patch",
      apiOrigin,
      `/memories/${lifecycleFact.id}`,
      { method: "PATCH", token: state.userA.token, body: { content: updatedFactContent } },
      200,
      false
    );
    assert.equal(hash(await readMemory(lifecycleFact.id)), hash(beforeIdempotentPatch));

    const duplicateFact = await createMemory(
      apiOrigin,
      "idempotent_duplicate_create",
      state.userA.token,
      { memoryType: "fact", content: updatedFactContent },
      201,
      false
    );
    assert.equal(duplicateFact.id, lifecycleFact.id);

    await auditedApiRequest(
      "deactivate_permanent_fact",
      apiOrigin,
      `/memories/${lifecycleFact.id}`,
      { method: "DELETE", token: state.userA.token },
      200,
      true
    );
    const afterFirstDelete = await readMemory(lifecycleFact.id);
    assert.equal(afterFirstDelete.is_active, false);
    await auditedApiRequest(
      "repeat_deactivate_permanent_fact",
      apiOrigin,
      `/memories/${lifecycleFact.id}`,
      { method: "DELETE", token: state.userA.token },
      200,
      true
    );
    const afterSecondDelete = await readMemory(lifecycleFact.id);
    assert.equal(afterSecondDelete.is_active, false);
    assert.notEqual(afterSecondDelete.updated_at.toISOString(), afterFirstDelete.updated_at.toISOString());
    listed = await listMemories(apiOrigin, "list_after_deactivate", state.userA.token);
    assert.equal(listed.some((memory) => memory.id === lifecycleFact.id), false);

    const duplicateTarget = await createMemory(apiOrigin, "create_duplicate_target", state.userA.token, {
      memoryType: "fact",
      content: `${PREFIX} duplicate target`
    });
    const duplicateSource = await createMemory(apiOrigin, "create_duplicate_source", state.userA.token, {
      memoryType: "fact",
      content: `${PREFIX} duplicate source`
    });
    await auditedApiRequest(
      "reject_duplicate_patch",
      apiOrigin,
      `/memories/${duplicateSource.id}`,
      {
        method: "PATCH",
        token: state.userA.token,
        body: { content: `${PREFIX} duplicate target` }
      },
      409,
      false
    );
    assert.equal((await readMemory(duplicateSource.id)).content, `${PREFIX} duplicate source`);
    assert.equal((await readMemory(duplicateTarget.id)).content, `${PREFIX} duplicate target`);

    const dualExpiryContent = `${PREFIX} dual expiry marker`;
    const permanentExpiry = await createMemory(apiOrigin, "create_permanent_expiry_identity", state.userA.token, {
      memoryType: "fact",
      content: dualExpiryContent
    });
    const expiredTemporary = await createMemory(apiOrigin, "create_expired_temporary", state.userA.token, {
      memoryType: "fact",
      content: dualExpiryContent,
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    });
    const futureTemporary = await createMemory(apiOrigin, "create_future_temporary", state.userA.token, {
      memoryType: "fact",
      content: dualExpiryContent,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString()
    });
    assert.notEqual(permanentExpiry.id, expiredTemporary.id);
    assert.notEqual(permanentExpiry.id, futureTemporary.id);
    assert.equal((await readMemory(expiredTemporary.id)).is_active, true);
    assert.ok(new Date((await readMemory(expiredTemporary.id)).expires_at).getTime() < Date.now());
    listed = await listMemories(apiOrigin, "list_expiry_separation", state.userA.token);
    assert.ok(listed.some((memory) => memory.id === permanentExpiry.id));
    assert.ok(listed.some((memory) => memory.id === futureTemporary.id));
    assert.equal(listed.some((memory) => memory.id === expiredTemporary.id), false);
    await auditedApiRequest(
      "reject_invalid_expiry",
      apiOrigin,
      "/memories",
      {
        method: "POST",
        token: state.userA.token,
        body: { memoryType: "fact", content: `${PREFIX} invalid expiry`, expiresAt: "not-a-date" }
      },
      400,
      false
    );

    const userFact = await createMemory(apiOrigin, "attribute_user_nodejs", state.userA.token, {
      memoryType: "fact",
      content: `I prefer Node.js. ${PREFIX}`
    });
    const rahulFact = await createMemory(apiOrigin, "attribute_rahul_java", state.userA.token, {
      memoryType: "fact",
      subject: "Rahul",
      content: `Rahul prefers Java. ${PREFIX}`
    });
    const friendFact = await createMemory(apiOrigin, "attribute_friend_rahul_python", state.userA.token, {
      memoryType: "fact",
      subject: "Rahul",
      content: `My friend Rahul uses Python. ${PREFIX}`
    });
    const brotherFact = await createMemory(apiOrigin, "attribute_brother_java", state.userA.token, {
      memoryType: "fact",
      subject: "brother",
      content: `My brother works with Java. ${PREFIX}`
    });
    const explicitFact = await createMemory(apiOrigin, "attribute_explicit_rahul", state.userA.token, {
      memoryType: "fact",
      content: `[about: Rahul] Rahul prefers Java for DSA. ${PREFIX}`
    });
    const backendOld = await createMemory(apiOrigin, "create_backend_node_preference", state.userA.token, {
      memoryType: "preference",
      content: `My backend preference is Node.js. ${PREFIX}`,
      confidence: 0.95,
      importance: 4,
      sourceMessageId: state.provenanceMessageId
    });

    assert.equal((await readMemory(userFact.id)).content, `I prefer Node.js. ${PREFIX}`);
    assert.equal((await readMemory(rahulFact.id)).content, `[about: rahul] Rahul prefers Java. ${PREFIX}`);
    assert.equal((await readMemory(friendFact.id)).content, `[about: rahul] My friend Rahul uses Python. ${PREFIX}`);
    assert.equal((await readMemory(brotherFact.id)).content, `[about: user's brother] My brother works with Java. ${PREFIX}`);
    assert.equal((await readMemory(explicitFact.id)).content, `[about: rahul] Rahul prefers Java for DSA. ${PREFIX}`);
    assert.equal(analyzeMemoryAttribution((await readMemory(friendFact.id)).content).subject, "rahul");
    assert.equal(analyzeMemoryAttribution((await readMemory(brotherFact.id)).content).subject, "user's brother");

    await auditedApiRequest(
      "reject_mixed_subject_statement",
      apiOrigin,
      "/memories",
      {
        method: "POST",
        token: state.userA.token,
        body: { memoryType: "fact", content: `I use C++, but Rahul uses Java. ${PREFIX}` }
      },
      400,
      false
    );
    await auditedApiRequest(
      "reject_ambiguous_pronoun_statement",
      apiOrigin,
      "/memories",
      {
        method: "POST",
        token: state.userA.token,
        body: { memoryType: "fact", content: `He prefers Java. ${PREFIX}` }
      },
      400,
      false
    );
    recordCheck("subject_attribution", "real_http_and_postgresql", {
      userFacts: 1,
      rahulFacts: 2,
      relativeFacts: 1,
      ambiguousRejected: 2
    });

    const oldBackendRow = await readMemory(backendOld.id);
    const supersedePlan = planMemoryActions(
      [{
        action: "update",
        replaces_id: oldBackendRow.id,
        subject: "user",
        memory_type: "preference",
        content: `My backend preference is Python. ${PREFIX}`,
        duration: "permanent",
        expires_in_days: null,
        confidence: 0.96,
        importance: 4
      }],
      [oldBackendRow],
      [oldBackendRow]
    );
    assert.equal(supersedePlan.length, 1);
    assert.equal(supersedePlan[0].type, "supersede");
    const supersedeResult = await supersedeMemory(
      state.userA.id,
      oldBackendRow.id,
      "preference",
      supersedePlan[0].memory.content,
      {
        confidence: 0.96,
        importance: 4,
        sourceMessageId: state.provenanceMessageId
      }
    );
    assert.equal(supersedeResult.status, "superseded");
    state.memoryIds.add(supersedeResult.memory.id);
    const pythonBackend = await readMemory(supersedeResult.memory.id);
    assert.equal(pythonBackend.is_active, true);
    assert.equal((await readMemory(oldBackendRow.id)).is_active, false);
    assert.deepEqual((await activePreferences(state.userA.id, "backend")).map((memory) => memory.id), [pythonBackend.id]);

    const nodeHistory = await pool.query(
      "SELECT * FROM memories WHERE user_id = $1 AND memory_type = 'fact' AND content = $2",
      [state.userA.id, `Previous preference: My backend preference is Node.js. ${PREFIX}`]
    );
    assert.equal(nodeHistory.rowCount, 1);
    assert.equal(nodeHistory.rows[0].is_active, true);
    assert.equal(nodeHistory.rows[0].source_message_id, state.provenanceMessageId);
    assert.equal(nodeHistory.rows[0].confidence, oldBackendRow.confidence);
    assert.equal(nodeHistory.rows[0].importance, oldBackendRow.importance);

    const beforeRepeatedSupersede = hash(await readAuditState());
    const repeatedSupersede = await supersedeMemory(
      state.userA.id,
      oldBackendRow.id,
      "preference",
      supersedePlan[0].memory.content,
      {
        confidence: 0.96,
        importance: 4,
        sourceMessageId: state.provenanceMessageId
      }
    );
    assert.equal(repeatedSupersede.status, "superseded");
    assert.equal(repeatedSupersede.memory.id, pythonBackend.id);
    assert.equal(hash(await readAuditState()), beforeRepeatedSupersede);

    const rustBackend = await createMemory(apiOrigin, "create_existing_backend_replacement", state.userA.token, {
      memoryType: "preference",
      content: `My backend preference is Rust. ${PREFIX}`,
      confidence: 0.97,
      importance: 4,
      sourceMessageId: state.provenanceMessageId
    });
    assert.equal((await readMemory(pythonBackend.id)).is_active, false);
    assert.deepEqual((await activePreferences(state.userA.id, "backend")).map((memory) => memory.id), [rustBackend.id]);
    const backendHistory = await pool.query(
      `SELECT * FROM memories
       WHERE user_id = $1
         AND memory_type = 'fact'
         AND content LIKE $2
       ORDER BY id`,
      [state.userA.id, `Previous preference:%${PREFIX}%`]
    );
    assert.equal(backendHistory.rowCount, 2);
    assert.ok(backendHistory.rows.every((memory) => memory.source_message_id === state.provenanceMessageId));

    const frontendReact = await createMemory(apiOrigin, "create_frontend_react_preference", state.userA.token, {
      memoryType: "preference",
      content: `My frontend preference is React. ${PREFIX}`,
      sourceMessageId: state.provenanceMessageId
    });
    await auditedApiRequest(
      "update_frontend_preference_to_vue",
      apiOrigin,
      `/memories/${frontendReact.id}`,
      {
        method: "PATCH",
        token: state.userA.token,
        body: { content: `My frontend preference is Vue. ${PREFIX}` }
      },
      200,
      true
    );
    assert.equal((await readMemory(frontendReact.id)).content, `My frontend preference is Vue. ${PREFIX}`);
    assert.deepEqual((await activePreferences(state.userA.id, "frontend")).map((memory) => memory.id), [frontendReact.id]);
    const frontendHistory = await pool.query(
      "SELECT * FROM memories WHERE user_id = $1 AND content = $2",
      [state.userA.id, `Previous preference: My frontend preference is React. ${PREFIX}`]
    );
    assert.equal(frontendHistory.rowCount, 1);
    assert.equal(frontendHistory.rows[0].source_message_id, state.provenanceMessageId);
    recordCheck("preference_superseding_and_history", "deterministic_planner_and_real_postgresql", {
      backendActive: 1,
      frontendActive: 1,
      backendHistoryRows: backendHistory.rowCount,
      frontendHistoryRows: frontendHistory.rowCount,
      provenanceRetained: true,
      repeatedSupersedeIdempotent: true
    });

    const beforeInvalidSupersede = hash(await readAuditState());
    const unknownTarget = await supersedeMemory(
      state.userA.id,
      randomUUID(),
      "fact",
      `${PREFIX} invalid unknown supersede target`
    );
    assert.equal(unknownTarget.status, "invalid_target");
    const temporaryTarget = await supersedeMemory(
      state.userA.id,
      expiredTemporary.id,
      "fact",
      `${PREFIX} invalid temporary supersede target`
    );
    assert.equal(temporaryTarget.status, "incompatible_target");
    const wrongSubjectTarget = await supersedeMemory(
      state.userA.id,
      rustBackend.id,
      "preference",
      `[about: rahul] ${PREFIX} invalid subject supersede target`
    );
    assert.equal(wrongSubjectTarget.status, "incompatible_target");
    assert.equal(hash(await readAuditState()), beforeInvalidSupersede);

    const invalidPlans = planMemoryActions(
      [
        {
          action: "update",
          replaces_id: randomUUID(),
          subject: "user",
          memory_type: "preference",
          content: `My backend preference is Go. ${PREFIX}`,
          duration: "permanent",
          confidence: 0.95,
          importance: 4
        },
        {
          action: "update",
          replaces_id: oldBackendRow.id,
          subject: "rahul",
          memory_type: "preference",
          content: `My backend preference is Go. ${PREFIX}`,
          duration: "permanent",
          confidence: 0.95,
          importance: 4
        },
        {
          action: "update",
          replaces_id: oldBackendRow.id,
          subject: "user",
          memory_type: "preference",
          content: `My backend preference is Go. ${PREFIX}`,
          duration: "temporary",
          confidence: 0.95,
          importance: 4
        },
        {
          action: "update",
          replaces_id: oldBackendRow.id,
          subject: "user",
          memory_type: "preference",
          content: `My backend preference is Go. ${PREFIX}`,
          duration: "permanent",
          confidence: 0.5,
          importance: 4
        },
        {
          action: "update",
          replaces_id: oldBackendRow.id,
          subject: "user",
          memory_type: "fact",
          content: `Works with Go. ${PREFIX}`,
          duration: "permanent",
          confidence: 0.95,
          importance: 4
        }
      ],
      [oldBackendRow],
      [oldBackendRow]
    );
    assert.ok(invalidPlans.every((step) => step.type === "skip" && step.reason === "invalid_update"));
    recordCheck("invalid_supersede_rejected", "deterministic_planner_and_real_postgresql", {
      repositoryStatuses: [unknownTarget.status, temporaryTarget.status, wrongSubjectTarget.status],
      plannerSkips: invalidPlans.length,
      insertedRows: 0
    });

    const retrievalToken = `retrievalsignal${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const retrievalMarker = await createMemory(apiOrigin, "create_cross_conversation_marker", state.userA.token, {
      memoryType: "fact",
      content: `${PREFIX} ${retrievalToken}`,
      importance: 5,
      sourceMessageId: state.provenanceMessageId
    });
    const contextA = await retrieveMemoryContext(state.userA.id, retrievalToken, []);
    assert.ok(contextA.includes(retrievalToken));
    const contextExcluded = await retrieveMemoryContext(state.userA.id, retrievalToken, [state.provenanceMessageId]);
    assert.equal(contextExcluded.includes(retrievalToken), false);
    const contextB = await retrieveMemoryContext(state.userB.id, retrievalToken, []);
    assert.equal(contextB.includes(retrievalToken), false);
    const relevantB = await getRelevantMemories(state.userB.id, [retrievalToken], 100);
    assert.equal(relevantB.some((memory) => memory.content.includes(retrievalToken)), false);
    assert.equal((await readMemory(retrievalMarker.id)).source_message_id, state.provenanceMessageId);
    recordCheck("cross_conversation_retrieval", "real_postgresql", {
      ownerRetrieved: true,
      sourceHistoryExcluded: true,
      otherUserExcluded: true
    });

    const userBMemory = await createMemory(apiOrigin, "create_user_b_isolation_memory", state.userB.token, {
      memoryType: "fact",
      content: `${PREFIX} user B isolation marker`
    });

    const conversationsA = await auditedApiRequest(
      "list_owner_a_conversations",
      apiOrigin,
      "/conversations",
      { token: state.userA.token },
      200,
      false
    );
    const conversationsAData = await conversationsA.json();
    assert.ok(conversationsAData.conversations.some((item) => item.id === state.conversationA1.id));
    assert.ok(conversationsAData.conversations.some((item) => item.id === state.conversationA2.id));
    assert.equal(conversationsAData.conversations.some((item) => item.id === state.conversationB1.id), false);

    const conversationsB = await auditedApiRequest(
      "list_owner_b_conversations",
      apiOrigin,
      "/conversations",
      { token: state.userB.token },
      200,
      false
    );
    const conversationsBData = await conversationsB.json();
    assert.ok(conversationsBData.conversations.some((item) => item.id === state.conversationB1.id));
    assert.equal(conversationsBData.conversations.some((item) => item.id === state.conversationA1.id), false);
    assert.equal(conversationsBData.conversations.some((item) => item.id === state.conversationA2.id), false);

    listed = await listMemories(apiOrigin, "list_owner_a_memories_for_isolation", state.userA.token);
    assert.equal(listed.some((memory) => memory.id === userBMemory.id), false);
    const listedB = await listMemories(apiOrigin, "list_owner_b_memories_for_isolation", state.userB.token);
    assert.equal(listedB.some((memory) => memory.id === retrievalMarker.id), false);

    await auditedApiRequest(
      "cross_user_read_b_conversation",
      apiOrigin,
      `/conversations/${state.conversationB1.id}`,
      { token: state.userA.token },
      404,
      false
    );
    await auditedApiRequest(
      "cross_user_read_a_conversation",
      apiOrigin,
      `/conversations/${state.conversationA1.id}`,
      { token: state.userB.token },
      404,
      false
    );
    await auditedApiRequest(
      "cross_user_update_b_memory",
      apiOrigin,
      `/memories/${userBMemory.id}`,
      {
        method: "PATCH",
        token: state.userA.token,
        body: { content: `${PREFIX} unauthorized update` }
      },
      404,
      false
    );
    await auditedApiRequest(
      "cross_user_update_a_memory",
      apiOrigin,
      `/memories/${retrievalMarker.id}`,
      {
        method: "PATCH",
        token: state.userB.token,
        body: { content: `${PREFIX} unauthorized update` }
      },
      404,
      false
    );
    await auditedApiRequest(
      "cross_user_deactivate_b_memory",
      apiOrigin,
      `/memories/${userBMemory.id}`,
      { method: "DELETE", token: state.userA.token },
      404,
      false
    );
    await auditedApiRequest(
      "cross_user_deactivate_a_memory",
      apiOrigin,
      `/memories/${retrievalMarker.id}`,
      { method: "DELETE", token: state.userB.token },
      404,
      false
    );
    await auditedApiRequest("unauthenticated_memory_list", apiOrigin, "/memories", {}, 401, false);
    await auditedApiRequest(
      "invalid_token_memory_list",
      apiOrigin,
      "/memories",
      { token: "invalid.jwt.token" },
      401,
      false
    );
    assert.equal((await readMemory(userBMemory.id)).is_active, true);
    assert.equal((await readMemory(retrievalMarker.id)).is_active, true);
    recordCheck("cross_user_http_isolation", "real_http_and_postgresql", {
      bidirectionalConversationDenial: true,
      bidirectionalMemoryExclusion: true,
      bidirectionalUpdateDenial: true,
      bidirectionalDeactivateDenial: true,
      unauthorizedDatabaseChanges: 0
    });

    await auditedApiRequest(
      "reject_unknown_create_field",
      apiOrigin,
      "/memories",
      {
        method: "POST",
        token: state.userA.token,
        body: { memoryType: "fact", content: `${PREFIX} unknown field`, unexpected: true }
      },
      400,
      false
    );
    await auditedApiRequest(
      "reject_invalid_memory_type",
      apiOrigin,
      "/memories",
      {
        method: "POST",
        token: state.userA.token,
        body: { memoryType: "secret", content: `${PREFIX} invalid type` }
      },
      400,
      false
    );
    await auditedApiRequest(
      "reject_invalid_confidence",
      apiOrigin,
      "/memories",
      {
        method: "POST",
        token: state.userA.token,
        body: { memoryType: "fact", content: `${PREFIX} invalid confidence`, confidence: 1.1 }
      },
      400,
      false
    );
    await auditedApiRequest(
      "reject_invalid_importance",
      apiOrigin,
      "/memories",
      {
        method: "POST",
        token: state.userA.token,
        body: { memoryType: "fact", content: `${PREFIX} invalid importance`, importance: 0 }
      },
      400,
      false
    );
    await auditedApiRequest(
      "reject_invalid_source_uuid",
      apiOrigin,
      "/memories",
      {
        method: "POST",
        token: state.userA.token,
        body: { memoryType: "fact", content: `${PREFIX} invalid source`, sourceMessageId: "not-a-uuid" }
      },
      400,
      false
    );
    await auditedApiRequest(
      "reject_cross_user_source_message",
      apiOrigin,
      "/memories",
      {
        method: "POST",
        token: state.userB.token,
        body: {
          memoryType: "fact",
          content: `${PREFIX} cross user source`,
          sourceMessageId: state.provenanceMessageId
        }
      },
      400,
      false
    );
    await auditedApiRequest(
      "reject_unknown_patch_field",
      apiOrigin,
      `/memories/${rustBackend.id}`,
      {
        method: "PATCH",
        token: state.userA.token,
        body: { content: `My backend preference is Ruby. ${PREFIX}`, unexpected: true }
      },
      400,
      false
    );
    await auditedApiRequest(
      "reject_subject_change",
      apiOrigin,
      `/memories/${rahulFact.id}`,
      {
        method: "PATCH",
        token: state.userA.token,
        body: { content: `Rahul prefers Kotlin. ${PREFIX}`, subject: "user" }
      },
      400,
      false
    );
    await auditedApiRequest(
      "reject_ambiguous_patch",
      apiOrigin,
      `/memories/${userFact.id}`,
      {
        method: "PATCH",
        token: state.userA.token,
        body: { content: `He prefers Java. ${PREFIX}` }
      },
      400,
      false
    );
    await auditedApiRequest(
      "reject_inactive_memory_patch",
      apiOrigin,
      `/memories/${lifecycleFact.id}`,
      {
        method: "PATCH",
        token: state.userA.token,
        body: { content: `${PREFIX} inactive update` }
      },
      404,
      false
    );
    await auditedApiRequest(
      "reject_invalid_delete_uuid",
      apiOrigin,
      "/memories/not-a-uuid",
      { method: "DELETE", token: state.userA.token },
      400,
      false
    );
    await auditedApiRequest(
      "reject_empty_content",
      apiOrigin,
      "/memories",
      { method: "POST", token: state.userA.token, body: { memoryType: "fact", content: "   " } },
      400,
      false
    );
    recordCheck("manual_api_validation", "real_http_and_postgresql", {
      invalidRequestsRejected: 12,
      databaseChanges: 0
    });

    await finalAudit();
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await pool.end();
  }
});
