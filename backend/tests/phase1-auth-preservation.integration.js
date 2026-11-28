import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { validateIntegrationEnvironment } from "../src/config/integration-env.js";
import { readAuthUserVerificationRows } from "./phase1-auth.helpers.js";

if (process.env.INTEGRATION_MODE !== "true") {
  throw new Error("Approved isolated integration mode is required.");
}

validateIntegrationEnvironment();

const { default: app } = await import("../src/app.js");
const { default: pool } = await import("../src/config/database.js");

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(TEST_DIR, "../phase2-identities.integration.local.json"), "utf8"));
const ORIGINAL_USER_IDS = [
  "cf2740d5-eef5-44a8-ab70-3070bff87545",
  "dcc2ca1a-06f9-4de6-8062-a52a2b20fa8b",
  "374a7038-fa53-4dd9-aa15-c5cc576577d1",
  "2d22e2fb-8159-4ae7-b887-5866e60ef8b9"
];
const EXPECTED_USER_HASHES = {
  "2d22e2fb-8159-4ae7-b887-5866e60ef8b9": "15e9c0628f50e25f0648",
  "374a7038-fa53-4dd9-aa15-c5cc576577d1": "a475a32ca5398e3fac88",
  "cf2740d5-eef5-44a8-ab70-3070bff87545": "14a12c82320632bb4c4c",
  "dcc2ca1a-06f9-4de6-8062-a52a2b20fa8b": "e32afb4a84d03abfdcff"
};
const PHASE1_CONVERSATION_HASHES = {
  "0b40b29f-2cb8-4e00-9c10-2776dd0cbb01": "6fafe96bf8133d9b252d",
  "869477b7-2a4f-4320-95b7-bd14fc04ef95": "ab514e91480862efdce0"
};
const PHASE1_MEMORY_HASHES = {
  "1135931f-c057-4013-9e54-0938fd54477e": "356bd1a4d81fdd3dea18",
  "3e916603-7e7d-402b-85e4-9f9762f4de71": "776259dfb74e3f613fdb"
};

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
}

after(async () => {
  await pool.end();
});

test("Phase 1 read-only preservation verifies Auth rows sessions and owned records without recreation", async () => {
  assert.equal(process.env.TEST_NEON_PROJECT_ID, "odd-bread-81511600");
  assert.equal(process.env.TEST_NEON_BRANCH_ID, "br-lively-tree-bi1z37kh");
  assert.equal(process.env.DATABASE_URL, undefined);
  assert.equal(process.env.GROQ_API_KEY, undefined);
  assert.equal(process.env.TAVILY_API_KEY, undefined);

  const users = await readAuthUserVerificationRows(pool, ORIGINAL_USER_IDS);
  assert.equal(users.length, 4);
  for (const user of users) {
    assert.equal(hash(user), EXPECTED_USER_HASHES[user.id]);
  }

  const allUsers = await pool.query('SELECT id FROM neon_auth."user" ORDER BY id');
  assert.deepEqual(
    allUsers.rows.map((row) => row.id).sort(),
    [...ORIGINAL_USER_IDS, manifest.userAId, manifest.userBId].sort()
  );

  const sessions = await pool.query('SELECT count(*)::int AS count FROM neon_auth.session');
  assert.equal(sessions.rows[0].count, 12);
  const originalSessions = await pool.query(
    `SELECT count(*)::int AS count
     FROM neon_auth.session
     WHERE "userId" = ANY($1::uuid[])`,
    [ORIGINAL_USER_IDS]
  );
  assert.equal(originalSessions.rows[0].count, 8);

  const conversations = await pool.query("SELECT * FROM conversations ORDER BY id");
  const memories = await pool.query("SELECT * FROM memories ORDER BY id");
  const messages = await pool.query("SELECT * FROM messages ORDER BY id");

  for (const [id, expectedHash] of Object.entries(PHASE1_CONVERSATION_HASHES)) {
    const rows = conversations.rows.filter((row) => row.id === id);
    assert.equal(rows.length, 1);
    assert.equal(hash(rows[0]), expectedHash);
  }
  for (const [id, expectedHash] of Object.entries(PHASE1_MEMORY_HASHES)) {
    const rows = memories.rows.filter((row) => row.id === id);
    assert.equal(rows.length, 1);
    assert.equal(hash(rows[0]), expectedHash);
  }

  const counts = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM conversations) AS conversations,
       (SELECT count(*)::int FROM memories) AS memories,
       (SELECT count(*)::int FROM messages) AS messages,
       (SELECT count(*)::int FROM reminders) AS reminders,
       (SELECT count(*)::int FROM agent_tool_logs) AS agent_tool_logs`
  );
  assert.ok(counts.rows[0].conversations >= 5);
  assert.ok(counts.rows[0].memories >= 28);
  assert.ok(counts.rows[0].messages >= 1);
  assert.equal(counts.rows[0].reminders, 0);
  assert.equal(counts.rows[0].agent_tool_logs, 0);

  const sourceViolations = await pool.query(
    `SELECT count(*)::int AS count
     FROM memories m
     LEFT JOIN messages msg ON msg.id = m.source_message_id
     LEFT JOIN conversations c ON c.id = msg.conversation_id
     WHERE m.source_message_id IS NOT NULL
       AND (msg.id IS NULL OR c.user_id <> m.user_id)`
  );
  assert.equal(sourceViolations.rows[0].count, 0);

  const jwksResponse = await fetch(process.env.NEON_AUTH_JWKS_URL);
  assert.equal(jwksResponse.status, 200);
  const jwks = await jwksResponse.json();
  assert.equal(jwks.keys.length, 1);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiOrigin = `http://127.0.0.1:${server.address().port}`;
  const unauthenticatedStatuses = {};
  try {
    for (const [label, token] of [["missing", null], ["invalid", "invalid.jwt.token"]]) {
      const headers = { Accept: "application/json" };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await fetch(`${apiOrigin}/api/memories`, { headers });
      unauthenticatedStatuses[label] = response.status;
      assert.equal(response.status, 401);
      const data = await response.json();
      assert.equal(data.memories, undefined);
    }
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  const countsAfterHttp = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM conversations) AS conversations,
       (SELECT count(*)::int FROM memories) AS memories,
       (SELECT count(*)::int FROM messages) AS messages,
       (SELECT count(*)::int FROM reminders) AS reminders,
       (SELECT count(*)::int FROM agent_tool_logs) AS agent_tool_logs`
  );
  assert.deepEqual(countsAfterHttp.rows[0], counts.rows[0]);

  console.log(JSON.stringify({
    check: "phase1_read_only_preservation",
    authUsers: allUsers.rowCount,
    authSessions: sessions.rows[0].count,
    originalUserSessions: originalSessions.rows[0].count,
    counts: counts.rows[0],
    sourceOwnershipViolations: sourceViolations.rows[0].count,
    originalUsersUnchanged: true,
    phase1RowsUnchanged: true,
    jwksKeys: jwks.keys.length,
    unauthenticatedHttpStatuses: unauthenticatedStatuses,
    databaseUnchangedAfterHttp: true,
    usersCreated: 0,
    sessionsCreated: 0
  }, null, 2));
});
