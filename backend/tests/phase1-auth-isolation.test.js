import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { decodeJwt, createRemoteJWKSet, jwtVerify } from "jose";

import app from "../src/app.js";
import pool from "../src/config/database.js";
import { validateIntegrationEnvironment } from "../src/config/integration-env.js";
import { readAuthUserVerificationRows } from "./phase1-auth.helpers.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_FILE = path.join(TEST_DIR, "../phase1-identities.integration.local.json");
const ORIGINAL_USER_IDS = [
  "cf2740d5-eef5-44a8-ab70-3070bff87545",
  "dcc2ca1a-06f9-4de6-8062-a52a2b20fa8b"
];

if (process.env.INTEGRATION_MODE !== "true") {
  throw new Error("Approved isolated integration mode is required.");
}

validateIntegrationEnvironment();

const AUTH_BASE_URL = process.env.TEST_NEON_AUTH_URL.replace(/\/+$/, "");
const AUTH_ORIGIN = process.env.TEST_AUTH_ORIGIN;
const ISSUER = new URL(process.env.NEON_AUTH_BASE_URL).origin;
const JWKS = createRemoteJWKSet(new URL(process.env.NEON_AUTH_JWKS_URL));
const state = { originalUsers: null };
const statuses = {};

function recordStatus(name, status) {
  statuses[name] = status;
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
  recordStatus(label, response.status);
  assert.equal(response.status, expectedStatus, `${label} returned HTTP ${response.status}`);
  return { response, sessionCookie };
}

async function issueAndVerifyToken(user, cookie, label) {
  const { response } = await requireAuthResponse(
    "/token",
    { cookie },
    200,
    `replacement_${label}_token_issuance`
  );
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
  const email = `minimi-phase1-replacement-${label.toLowerCase()}-${randomUUID()}@example.com`;
  const password = `${randomBytes(24).toString("base64url")}Aa1!`;
  const name = `Minimi Phase 1 Replacement User ${label}`;

  const signup = await requireAuthResponse(
    "/sign-up/email",
    {
      method: "POST",
      body: { name, email, password }
    },
    200,
    `replacement_${label}_signup`
  );
  const signupData = await signup.response.json();
  assert.equal(typeof signupData.user?.id, "string");
  assert.ok(signupData.user.id);
  assert.equal(signupData.user.email, email);

  const signin = await requireAuthResponse(
    "/sign-in/email",
    {
      method: "POST",
      body: { email, password }
    },
    200,
    `replacement_${label}_signin`
  );
  const signinData = await signin.response.json();
  assert.equal(signinData.user?.id, signupData.user.id);
  assert.ok(signin.sessionCookie);

  const token = await issueAndVerifyToken(signupData.user, signin.sessionCookie, label);

  return {
    id: signupData.user.id,
    token
  };
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

function saveManifest() {
  writeFileSync(MANIFEST_FILE, `${JSON.stringify({
    projectId: process.env.TEST_NEON_PROJECT_ID,
    branchId: process.env.TEST_NEON_BRANCH_ID,
    originalUserAId: ORIGINAL_USER_IDS[0],
    originalUserBId: ORIGINAL_USER_IDS[1],
    replacementUserAId: state.userA?.id,
    replacementUserBId: state.userB?.id,
    conversationAId: state.conversationA?.id,
    conversationBId: state.conversationB?.id,
    memoryAId: state.memoryA?.id,
    memoryBId: state.memoryB?.id,
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`);
}

async function readOwnershipState() {
  const [conversations, memories] = await Promise.all([
    pool.query(
      `SELECT id, user_id, title, created_at, updated_at
       FROM conversations
       ORDER BY id`
    ),
    pool.query(
      `SELECT id, user_id, memory_type, content, is_active, created_at, updated_at
       FROM memories
       ORDER BY id`
    )
  ]);

  return { conversations: conversations.rows, memories: memories.rows };
}

async function auditedApiRequest(
  name,
  apiOrigin,
  route,
  options,
  expectedStatus,
  expectedDatabaseChange = false
) {
  const before = await readOwnershipState();
  const response = await apiRequest(apiOrigin, route, options);
  const after = await readOwnershipState();
  const databaseChanged = JSON.stringify(before) !== JSON.stringify(after);

  recordStatus(name, { httpStatus: response.status, databaseChanged });
  assert.equal(response.status, expectedStatus, `${name} returned HTTP ${response.status}`);
  assert.equal(databaseChanged, expectedDatabaseChange, `${name} database-change mismatch`);

  return response;
}

async function preflight() {
  assert.equal(process.env.INTEGRATION_MODE, "true");
  assert.equal(process.env.TEST_NEON_PROJECT_ID, "odd-bread-81511600");
  assert.equal(process.env.TEST_NEON_BRANCH_ID, "br-lively-tree-bi1z37kh");
  assert.equal(process.env.DATABASE_URL, undefined);
  assert.equal(process.env.GROQ_API_KEY, undefined);
  assert.equal(process.env.TAVILY_API_KEY, undefined);
  assert.equal(process.env.TEST_CONVERSATION_ID, undefined);
  assert.equal(process.env.TEST_MEMORY_ID, undefined);

  const apiUrl = new URL(process.env.TEST_API_URL);
  assert.equal(apiUrl.protocol, "http:");
  assert.ok(["localhost", "127.0.0.1"].includes(apiUrl.hostname));

  const cookieFile = path.resolve(process.env.TEST_COOKIE_FILE);
  assert.ok(existsSync(cookieFile));
  assert.ok(statSync(cookieFile).isFile());
  assert.equal(statSync(cookieFile).size, 0);

  const tables = await pool.query(
    `SELECT count(*)::int AS count
     FROM information_schema.tables
     WHERE table_schema = $1
       AND table_name = ANY($2)`,
    ["public", ["conversations", "messages", "memories", "reminders", "agent_tool_logs"]]
  );
  assert.equal(tables.rows[0].count, 5);

  const foreignKeys = await pool.query(
    `SELECT count(*)::int AS count
     FROM pg_constraint
     WHERE contype = 'f'
       AND confrelid = 'neon_auth."user"'::regclass
       AND connamespace = 'public'::regnamespace`
  );
  assert.equal(foreignKeys.rows[0].count, 4);

  const baseline = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM neon_auth."user") AS auth_users,
       (SELECT count(*)::int FROM conversations) AS conversations,
       (SELECT count(*)::int FROM memories) AS memories,
       (SELECT count(*)::int FROM messages) AS messages,
       (SELECT count(*)::int FROM reminders) AS reminders,
       (SELECT count(*)::int FROM agent_tool_logs) AS agent_tool_logs`
  );
  assert.deepEqual(baseline.rows[0], {
    auth_users: 2,
    conversations: 0,
    memories: 0,
    messages: 0,
    reminders: 0,
    agent_tool_logs: 0
  });

  const originalUsers = await readAuthUserVerificationRows(pool, ORIGINAL_USER_IDS);
  assert.deepEqual(
    originalUsers.map((row) => row.id).sort(),
    [...ORIGINAL_USER_IDS].sort()
  );
  state.originalUsers = originalUsers;

  const ownershipBaseline = await readOwnershipState();
  assert.deepEqual(ownershipBaseline, { conversations: [], memories: [] });

  const jwksResponse = await fetch(process.env.NEON_AUTH_JWKS_URL);
  assert.equal(jwksResponse.status, 200);
  const jwks = await jwksResponse.json();
  assert.equal(jwks.keys.length, 1);
}

async function authentication(apiOrigin) {
  const rejectionCases = [
    { name: "unauthenticated", token: null },
    { name: "invalid_token", token: "invalid.jwt.token" },
    { name: "malformed_token", token: "not-a-jwt" }
  ];

  for (const item of rejectionCases) {
    const response = await apiRequest(apiOrigin, "/memories", { token: item.token });
    recordStatus(item.name, response.status);
    assert.equal(response.status, 401);
  }

  state.userA = await createSyntheticUser("A");
  state.userB = await createSyntheticUser("B");
  assert.notEqual(state.userA.id, state.userB.id);
  assert.ok(!ORIGINAL_USER_IDS.includes(state.userA.id));
  assert.ok(!ORIGINAL_USER_IDS.includes(state.userB.id));
  saveManifest();

  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const expiredToken = [
    encode({ alg: "RS256", typ: "JWT" }),
    encode({
      sub: state.userA.id,
      iss: ISSUER,
      aud: ISSUER,
      iat: now - 120,
      exp: now - 60
    }),
    "AA"
  ].join(".");

  const expiredResponse = await apiRequest(apiOrigin, "/memories", {
    token: expiredToken
  });
  recordStatus("expired_synthetic_token", expiredResponse.status);
  assert.equal(expiredResponse.status, 401);

  for (const [label, user] of [["A", state.userA], ["B", state.userB]]) {
    const response = await apiRequest(apiOrigin, "/memories", { token: user.token });
    recordStatus(`replacement_${label}_valid_token_access`, response.status);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.memories, []);
  }

  const totalUsers = await pool.query('SELECT count(*)::int AS count FROM neon_auth."user"');
  assert.equal(totalUsers.rows[0].count, 4);

  const expectedUserIds = [...ORIGINAL_USER_IDS, state.userA.id, state.userB.id];
  const verificationUsers = await readAuthUserVerificationRows(pool, expectedUserIds);
  assert.deepEqual(
    verificationUsers.map((row) => row.id).sort(),
    [...expectedUserIds].sort()
  );

  const originalUsers = verificationUsers.filter((row) => ORIGINAL_USER_IDS.includes(row.id));
  assert.deepEqual(originalUsers, state.originalUsers);
}

async function ownership(apiOrigin) {
  const conversationBodies = {
    A: { title: `Minimi Phase 1 replacement conversation A ${randomUUID()}` },
    B: { title: `Minimi Phase 1 replacement conversation B ${randomUUID()}` }
  };
  const memoryContent = {
    A: "Synthetic replacement ownership marker A for Phase 1.",
    B: "Synthetic replacement ownership marker B for Phase 1."
  };

  for (const label of ["A", "B"]) {
    const user = state[`user${label}`];
    const conversationResponse = await auditedApiRequest(
      `replacement_${label}_create_conversation`,
      apiOrigin,
      "/conversations",
      {
        method: "POST",
        token: user.token,
        body: conversationBodies[label]
      },
      201,
      true
    );
    const conversationData = await conversationResponse.json();
    assert.equal(conversationData.success, true);
    assert.equal(typeof conversationData.conversation?.id, "string");
    state[`conversation${label}`] = conversationData.conversation;

    const memoryResponse = await auditedApiRequest(
      `replacement_${label}_create_memory`,
      apiOrigin,
      "/memories",
      {
        method: "POST",
        token: user.token,
        body: {
          memoryType: "fact",
          content: memoryContent[label]
        }
      },
      201,
      true
    );
    const memoryData = await memoryResponse.json();
    assert.equal(memoryData.success, true);
    assert.equal(typeof memoryData.memory?.id, "string");
    state[`memory${label}`] = memoryData.memory;
  }

  saveManifest();

  for (const label of ["A", "B"]) {
    const user = state[`user${label}`];
    const conversation = state[`conversation${label}`];
    const memory = state[`memory${label}`];

    const ownConversationResponse = await auditedApiRequest(
      `replacement_${label}_read_own_conversation`,
      apiOrigin,
      `/conversations/${conversation.id}`,
      { token: user.token },
      200
    );
    const ownConversationData = await ownConversationResponse.json();
    assert.equal(ownConversationData.conversation.id, conversation.id);
    assert.equal(ownConversationData.conversation.user_id, user.id);

    const ownMemoriesResponse = await auditedApiRequest(
      `replacement_${label}_read_own_memories`,
      apiOrigin,
      "/memories",
      { token: user.token },
      200
    );
    const ownMemoriesData = await ownMemoriesResponse.json();
    assert.deepEqual(ownMemoriesData.memories.map((item) => item.id), [memory.id]);
    assert.equal(ownMemoriesData.memories[0].user_id, user.id);
  }

  for (const [owner, intruder] of [["A", "B"], ["B", "A"]]) {
    const targetConversation = state[`conversation${owner}`];
    const crossConversationResponse = await auditedApiRequest(
      `replacement_${intruder}_read_${owner}_conversation`,
      apiOrigin,
      `/conversations/${targetConversation.id}`,
      { token: state[`user${intruder}`].token },
      404
    );
    const crossConversationData = await crossConversationResponse.json();
    assert.equal(crossConversationData.conversation, undefined);
    assert.equal(JSON.stringify(crossConversationData).includes(targetConversation.title), false);

    const targetMemory = state[`memory${owner}`];
    const crossMemoriesResponse = await auditedApiRequest(
      `replacement_${intruder}_read_${owner}_memories`,
      apiOrigin,
      "/memories",
      { token: state[`user${intruder}`].token },
      200
    );
    const crossMemoriesData = await crossMemoriesResponse.json();
    assert.equal(
      crossMemoriesData.memories.some((item) => item.id === targetMemory.id),
      false
    );
    assert.equal(JSON.stringify(crossMemoriesData).includes(targetMemory.content), false);
    assert.deepEqual(
      crossMemoriesData.memories.map((item) => item.id),
      [state[`memory${intruder}`].id]
    );
  }

  for (const [owner, intruder] of [["A", "B"], ["B", "A"]]) {
    const target = state[`memory${owner}`];
    await auditedApiRequest(
      `replacement_${intruder}_update_${owner}_memory`,
      apiOrigin,
      `/memories/${target.id}`,
      {
        method: "PATCH",
        token: state[`user${intruder}`].token,
        body: { content: `Unauthorized synthetic update from replacement User ${intruder}.` }
      },
      404
    );

    await auditedApiRequest(
      `replacement_${intruder}_deactivate_${owner}_memory`,
      apiOrigin,
      `/memories/${target.id}`,
      {
        method: "DELETE",
        token: state[`user${intruder}`].token
      },
      404
    );
  }

  const persisted = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM neon_auth."user") AS auth_users,
       (SELECT count(*)::int FROM conversations) AS conversations,
       (SELECT count(*)::int FROM memories) AS memories,
       (SELECT count(*)::int FROM memories WHERE is_active = TRUE) AS active_memories`
  );
  assert.deepEqual(persisted.rows[0], {
    auth_users: 4,
    conversations: 2,
    memories: 2,
    active_memories: 2
  });
  state.persistedCounts = persisted.rows[0];

  const conversationOwners = await pool.query(
    `SELECT user_id, count(*)::int AS count
     FROM conversations
     GROUP BY user_id
     ORDER BY user_id`
  );
  assert.deepEqual(
    conversationOwners.rows,
    [state.userA.id, state.userB.id].sort().map((user_id) => ({ user_id, count: 1 }))
  );

  const memoryOwners = await pool.query(
    `SELECT user_id, count(*)::int AS count
     FROM memories
     GROUP BY user_id
     ORDER BY user_id`
  );
  assert.deepEqual(
    memoryOwners.rows,
    [state.userA.id, state.userB.id].sort().map((user_id) => ({ user_id, count: 1 }))
  );

  for (const label of ["A", "B"]) {
    const conversation = state[`conversation${label}`];
    const memory = state[`memory${label}`];
    const userId = state[`user${label}`].id;

    const conversationRows = await pool.query(
      "SELECT id, user_id, title FROM conversations WHERE id = $1",
      [conversation.id]
    );
    assert.equal(conversationRows.rowCount, 1);
    assert.equal(conversationRows.rows[0].user_id, userId);
    assert.equal(conversationRows.rows[0].title, conversation.title);

    const memoryRows = await pool.query(
      "SELECT id, user_id, content, is_active FROM memories WHERE id = $1",
      [memory.id]
    );
    assert.equal(memoryRows.rowCount, 1);
    assert.equal(memoryRows.rows[0].user_id, userId);
    assert.equal(memoryRows.rows[0].content, memoryContent[label]);
    assert.equal(memoryRows.rows[0].is_active, true);
  }

  const verificationUsers = await readAuthUserVerificationRows(pool, [
    ...ORIGINAL_USER_IDS,
    state.userA.id,
    state.userB.id
  ]);
  const originalUsers = verificationUsers.filter((row) => ORIGINAL_USER_IDS.includes(row.id));
  assert.deepEqual(originalUsers, state.originalUsers);
}

test("Phase 1 recovery real Neon Auth and user isolation", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiOrigin = `http://127.0.0.1:${server.address().port}`;

  try {
    let preflightPassed = false;
    await t.test("Phase 1A isolated recovery preflight", async () => {
      await preflight();
      preflightPassed = true;
    });

    if (!preflightPassed) {
      return;
    }

    let authenticationPassed = false;
    await t.test("Phase 1B replacement user Managed Better Auth", async () => {
      await authentication(apiOrigin);
      authenticationPassed = true;
    });

    if (!authenticationPassed) {
      return;
    }

    let ownershipPassed = false;
    await t.test("Phase 1C real HTTP ownership and PostgreSQL persistence", async () => {
      await ownership(apiOrigin);
      ownershipPassed = true;
    });

    if (ownershipPassed) {
      console.log(JSON.stringify({
        phase1_http_statuses: statuses,
        synthetic_ids: {
          originalUserAId: ORIGINAL_USER_IDS[0],
          originalUserBId: ORIGINAL_USER_IDS[1],
          replacementUserAId: state.userA.id,
          replacementUserBId: state.userB.id,
          conversationAId: state.conversationA.id,
          conversationBId: state.conversationB.id,
          memoryAId: state.memoryA.id,
          memoryBId: state.memoryB.id
        },
        persisted_counts: state.persistedCounts,
        memory_read_by_id_endpoint: false,
        cross_memory_read_method: "filtered_owner_list"
      }, null, 2));
    }
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await pool.end();
  }
});
