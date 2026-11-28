import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import pg from "pg";

import {
  APPROVED_INTEGRATION_TARGET,
  getIntegrationDatabaseConfig,
  validateIntegrationEnvironment
} from "../src/config/integration-env.js";
import {
  analyzeMemoryAttribution,
  getPreferenceCategory
} from "../src/utils/memory-format.js";

const EXPECTED_PROJECT_ID = "odd-bread-81511600";
const EXPECTED_BRANCH_ID = "br-lively-tree-bi1z37kh";
const EXPECTED_ENDPOINT = APPROVED_INTEGRATION_TARGET.databaseHost.split(".")[0].replace(/-pooler$/, "");
const RUN_ID = `phase3-${randomUUID()}`;
const DUPLICATE_WIDTHS = process.env.PHASE3_WIDTH_10 === "true" ? [5, 10] : [5];
const RUN_DUPLICATE_CREATION = process.env.PHASE3_SKIP_A !== "true";
const ONLY_F4 = process.env.PHASE3_ONLY_F4 === "true";
const RUN_MODE = ONLY_F4 ? "F4_ONLY" : RUN_DUPLICATE_CREATION ? "FULL" : "WITHOUT_A";
const EXPECTED_SCENARIO_CASES = ONLY_F4 ? ["F4"] : [
  ...(RUN_DUPLICATE_CREATION ? ["A"] : []),
  "B1",
  "B2",
  "C1",
  "C2",
  "D",
  "E",
  "F1",
  "F2",
  "F3",
  "F4"
];
const USER_A = process.env.TEST_PHASE3_USER_A_ID;
const USER_B = process.env.TEST_PHASE3_USER_B_ID;

let pool;
let createMemory;
let deactivateMemory;
let getMemoryById;
let getUserMemories;
let supersedeMemory;
let updateMemory;

if (process.env.INTEGRATION_MODE !== "true") {
  throw new Error("Approved isolated integration mode is required.");
}
validateIntegrationEnvironment();
assert.equal(process.env.TEST_NEON_PROJECT_ID, EXPECTED_PROJECT_ID);
assert.equal(process.env.TEST_NEON_BRANCH_ID, EXPECTED_BRANCH_ID);
assert.ok(USER_A && USER_B && USER_A !== USER_B);
const fixtureManifest = JSON.parse(readFileSync(
  new URL("../phase2-identities.integration.local.json", import.meta.url),
  "utf8"
));
assert.equal(USER_A, fixtureManifest.userAId);
assert.equal(USER_B, fixtureManifest.userBId);

const authUrl = new URL(process.env.NEON_AUTH_BASE_URL);
const jwksUrl = new URL(process.env.NEON_AUTH_JWKS_URL);
assert.equal(authUrl.hostname.split(".")[0], EXPECTED_ENDPOINT);
assert.equal(jwksUrl.hostname.split(".")[0], EXPECTED_ENDPOINT);

function instrumentPoolConnect(pool, originalConnect, hooks) {
  pool.connect = (...args) => {
    const callback = typeof args.at(-1) === "function" ? args.pop() : null;
    const acquisition = new Promise((resolve, reject) => {
      originalConnect(...args, (error, client, release) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ client, release });
      });
    });

    const acquired = acquisition.then(async ({ client, release }) => {
      hooks.acquire();
      let released = false;
      const wrappedRelease = (error) => {
        if (!released) {
          released = true;
          hooks.release();
        }
        return release(error);
      };
      client.release = wrappedRelease;
      try {
        await hooks.ready(client);
      } catch (error) {
        wrappedRelease(error);
        throw error;
      }
      return { client, wrappedRelease };
    });

    return acquired.then(
      ({ client, wrappedRelease }) => {
        if (callback) {
          callback(null, client, wrappedRelease);
        }
        return client;
      },
      (error) => {
        if (callback) {
          callback(error);
          return undefined;
        }
        throw error;
      }
    );
  };
}

const auditPool = new pg.Pool({
  ...getIntegrationDatabaseConfig(),
  max: 3
});
let auditActiveClients = 0;
let auditAcquiredClients = 0;
let auditReleasedClients = 0;
const auditBackendPids = [];
const originalAuditConnect = auditPool.connect.bind(auditPool);

instrumentPoolConnect(auditPool, originalAuditConnect, {
  acquire() {
    auditActiveClients += 1;
    auditAcquiredClients += 1;
  },
  async ready(client) {
    const pidResult = await client.query("SELECT pg_backend_pid() AS pid");
    auditBackendPids.push(pidResult.rows[0].pid);
  },
  release() {
    auditActiveClients -= 1;
    auditReleasedClients += 1;
  }
});

const batches = [];
const scenarios = [];
const sqlstates = new Set();
let baseline;
let baselineIds;
let activeClients = 0;
let acquiredClients = 0;
let releasedClients = 0;
let connectGate = null;
let lastBackendPid = null;
const backendPids = [];
let originalConnect;

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeMemoryKey(content) {
  return String(content ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function errorEvidence(error) {
  const code = error?.cause?.code ?? error?.code ?? null;
  if (code) {
    sqlstates.add(code);
  }
  return {
    name: error?.name ?? "Error",
    code,
    constraint: error?.cause?.constraint ?? error?.constraint ?? null
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs = 5000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) {
      return result;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function execute(label, operation) {
  const started = performance.now();
  try {
    const value = await operation();
    return { label, ok: true, value, durationMs: performance.now() - started };
  } catch (error) {
    return { label, ok: false, error: errorEvidence(error), durationMs: performance.now() - started };
  }
}

function beginConnectGate(expected) {
  let resolveGate;
  let rejectGate;
  const promise = new Promise((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = reject;
  });
  const timer = setTimeout(() => {
    rejectGate(new Error(`Concurrency connect barrier timed out for ${expected} operations.`));
  }, 15000);
  connectGate = {
    expected,
    arrived: 0,
    peakActive: 0,
    promise,
    resolve() {
      clearTimeout(timer);
      resolveGate();
    }
  };
}

async function runBatch(label, expected, operations, { connectBarrier = true } = {}) {
  if (connectBarrier) {
    beginConnectGate(expected);
  }

  const pidStart = backendPids.length;
  const started = performance.now();
  const results = await Promise.all(operations.map((operation, index) =>
    execute(`${label}[${index + 1}]`, operation)
  ));
  const gate = connectGate;
  if (gate) {
    gate.resolve();
  }
  connectGate = null;

  const batchPids = backendPids.slice(pidStart);
  const durations = results.map((result) => result.durationMs);
  const batch = {
    label,
    simultaneousOperations: expected,
    connectBarrier,
    checkedOutClients: gate?.peakActive ?? null,
    backendPidCount: batchPids.length,
    uniqueBackendPidCount: new Set(batchPids).size,
    totalDurationMs: performance.now() - started,
    minOperationMs: Math.min(...durations),
    maxOperationMs: Math.max(...durations),
    successes: results.filter((result) => result.ok).length,
    failures: results.filter((result) => !result.ok).map((result) => ({
      label: result.label,
      error: result.error
    }))
  };
  batches.push(batch);
  console.log(JSON.stringify({ check: "phase3_batch", ...batch }, null, 2));

  if (connectBarrier) {
    assert.equal(gate.arrived, expected, `${label} did not acquire every expected client`);
    assert.equal(gate.peakActive, expected, `${label} did not overlap all expected clients`);
    assert.equal(batchPids.length, expected, `${label} did not record every backend PID`);
  }

  return results;
}

async function readCounts() {
  const result = await auditPool.query(
    `SELECT
      (SELECT count(*)::int FROM neon_auth."user") AS auth_users,
      (SELECT count(*)::int FROM neon_auth.session) AS auth_sessions,
      (SELECT count(*)::int FROM conversations) AS conversations,
      (SELECT count(*)::int FROM memories) AS memories,
      (SELECT count(*)::int FROM memories WHERE is_active = TRUE) AS active_memories,
      (SELECT count(*)::int FROM messages) AS messages,
      (SELECT count(*)::int FROM reminders) AS reminders,
      (SELECT count(*)::int FROM agent_tool_logs) AS agent_tool_logs`
  );
  return result.rows[0];
}

async function readPreservationState() {
  const [users, sessions, conversations, memories, messages, reminders, toolLogs] = await Promise.all([
    auditPool.query(
      `SELECT id, name, email, "emailVerified", "createdAt", "updatedAt"
       FROM neon_auth."user" ORDER BY id`
    ),
    auditPool.query(
      `SELECT id, "userId", "createdAt", "updatedAt", "expiresAt"
       FROM neon_auth.session ORDER BY id`
    ),
    auditPool.query("SELECT * FROM conversations ORDER BY id"),
    auditPool.query("SELECT * FROM memories ORDER BY id"),
    auditPool.query("SELECT * FROM messages ORDER BY id"),
    auditPool.query("SELECT * FROM reminders ORDER BY id"),
    auditPool.query("SELECT * FROM agent_tool_logs ORDER BY id")
  ]);

  return {
    users: users.rows,
    sessions: sessions.rows,
    conversations: conversations.rows,
    memories: memories.rows,
    messages: messages.rows,
    reminders: reminders.rows,
    toolLogs: toolLogs.rows
  };
}

function ids(rows) {
  return new Set(rows.map((row) => row.id));
}

function filterByIds(rows, rowIds) {
  return rows.filter((row) => rowIds.has(row.id));
}

async function readMemory(memoryId) {
  const result = await auditPool.query("SELECT * FROM memories WHERE id = $1", [memoryId]);
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function activeSubjectPreferences(userId, subject, category = "backend") {
  const result = await auditPool.query(
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

async function exactContentCount(userId, memoryType, content) {
  const result = await auditPool.query(
    "SELECT count(*)::int AS count FROM memories WHERE user_id = $1 AND memory_type = $2 AND content = $3",
    [userId, memoryType, content]
  );
  return result.rows[0].count;
}

function expectedHistory(content) {
  const attribution = analyzeMemoryAttribution(content);
  return attribution.subject === "user"
    ? `Previous preference: ${attribution.text}`
    : `[about: ${attribution.subject}] Previous preference: ${attribution.text}`;
}

function cookieJarBytes() {
  try {
    return statSync(path.resolve(process.env.TEST_COOKIE_FILE)).size;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function preflight() {
  assert.equal(process.env.TEST_NEON_PROJECT_ID, EXPECTED_PROJECT_ID);
  assert.equal(process.env.TEST_NEON_BRANCH_ID, EXPECTED_BRANCH_ID);
  assert.equal(process.env.DATABASE_URL, undefined);
  assert.equal(process.env.GROQ_API_KEY, undefined);
  assert.equal(process.env.TAVILY_API_KEY, undefined);
  assert.ok(USER_A && USER_B && USER_A !== USER_B);

  const integrationValues = Object.entries(process.env)
    .filter(([key]) => key.startsWith("TEST_") ||
      key === "DATABASE_URL_POOLED" ||
      key === "NEON_AUTH_BASE_URL" ||
      key === "NEON_AUTH_JWKS_URL")
    .map(([, value]) => String(value));
  for (const forbidden of ["winter-math-54988029", "br-restless-silence-ao5ra3rh", "ep-calm-violet-aophputx"]) {
    assert.equal(integrationValues.some((value) => value.includes(forbidden)), false);
  }

  const identity = await auditPool.query(
    "SELECT current_database() AS database, current_user AS db_user, version() AS version"
  );
  const counts = await readCounts();
  assert.equal(counts.auth_users, 6);
  assert.equal(counts.auth_sessions, 12);
  assert.ok(counts.conversations >= 8);
  assert.ok(counts.memories >= 75);
  assert.ok(counts.active_memories >= 64);
  assert.ok(counts.messages >= 4);
  assert.equal(counts.reminders, 0);
  assert.equal(counts.agent_tool_logs, 0);

  baseline = await readPreservationState();
  baselineIds = {
    users: ids(baseline.users),
    sessions: ids(baseline.sessions),
    conversations: ids(baseline.conversations),
    memories: ids(baseline.memories),
    messages: ids(baseline.messages),
    reminders: ids(baseline.reminders),
    toolLogs: ids(baseline.toolLogs)
  };
  assert.equal(baseline.users.length, 6);
  assert.ok(baselineIds.users.has(USER_A));
  assert.ok(baselineIds.users.has(USER_B));

  console.log(JSON.stringify({
    check: "phase3_preflight",
    runId: RUN_ID,
    runMode: RUN_MODE,
    projectId: EXPECTED_PROJECT_ID,
    branchId: EXPECTED_BRANCH_ID,
    endpoint: EXPECTED_ENDPOINT,
    databaseHost: APPROVED_INTEGRATION_TARGET.databaseHost,
    database: identity.rows[0].database,
    dbUser: identity.rows[0].db_user,
    postgresVersion: identity.rows[0].version,
    counts,
    snapshotHash: hash(baseline),
    authenticatedHttpConcurrency: cookieJarBytes() > 0 ? "NOT_ATTEMPTED" : "BLOCKED",
    cookieJarBytes: cookieJarBytes()
  }, null, 2));
}

async function duplicateCreationScenarios() {
  for (const width of DUPLICATE_WIDTHS) {
    for (let repetition = 1; repetition <= 1; repetition += 1) {
      const content = `I use Node.js for ${RUN_ID} duplicate width ${width} repetition ${repetition}.`;
      const variants = Array.from({ length: width }, (_, index) => {
        if (index % 3 === 1) {
          return content.toUpperCase();
        }
        if (index % 3 === 2) {
          return `  ${content.toLowerCase().replace(/\./g, " ")}  `;
        }
        return content;
      });
      const label = `A_duplicate_w${width}_r${repetition}`;
      const results = await runBatch(label, width, variants.map((variant) => () =>
        createMemory(USER_A, "fact", variant)
      ));
      assert.ok(results.every((result) => result.ok && result.value), label);
      const memoryIds = new Set(results.map((result) => result.value.id));
      assert.equal(memoryIds.size, 1, label);
      const memoryId = [...memoryIds][0];
      const row = await readMemory(memoryId);
      assert.equal(row.user_id, USER_A);
      assert.equal(row.is_active, true);
      assert.equal(row.expires_at, null);

      const normalized = normalizeMemoryKey(content);
      const result = await auditPool.query(
        `SELECT count(*)::int AS count
         FROM memories
         WHERE user_id = $1
           AND memory_type = 'fact'
           AND is_active = TRUE
           AND expires_at IS NULL
           AND trim(regexp_replace(lower(content), '[^a-z0-9]+', ' ', 'g')) = $2`,
        [USER_A, normalized]
      );
      assert.equal(result.rows[0].count, 1, label);
      scenarios.push({
        case: "A",
        label,
        width,
        repetition,
        uniqueMemoryIds: memoryIds.size,
        activeLogicalRows: result.rows[0].count,
        normalizedHash: hash(normalized)
      });
    }
  }
}

async function supersedeScenarios() {
  for (let repetition = 1; repetition <= 1; repetition += 1) {
    const subject = `phase3exact${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const oldContent = `[about: ${subject}] Backend preference is Node.js. ${RUN_ID} exact old ${repetition}`;
    const replacement = `[about: ${subject}] Backend preference is Python. ${RUN_ID} exact new ${repetition}`;
    const old = await createMemory(USER_A, "preference", oldContent);
    assert.ok(old);
    const label = `B1_exact_supersede_r${repetition}`;
    const results = await runBatch(label, 5, Array.from({ length: 5 }, () => () =>
      supersedeMemory(USER_A, old.id, "preference", replacement)
    ));
    assert.ok(results.every((result) => result.ok && result.value.status === "superseded"), label);
    const replacementIds = new Set(results.map((result) => result.value.memory.id));
    assert.equal(replacementIds.size, 1, label);
    assert.equal((await readMemory(old.id)).is_active, false);
    const active = await activeSubjectPreferences(USER_A, subject);
    assert.equal(active.length, 1, label);
    assert.match(active[0].content, /Python/);
    assert.equal(await exactContentCount(USER_A, "fact", expectedHistory(oldContent)), 1);
    scenarios.push({
      case: "B1",
      label,
      width: 5,
      repetition,
      statuses: results.map((result) => result.value.status),
      uniqueReplacementIds: replacementIds.size,
      activeWinners: active.length,
      historyRows: 1
    });
  }

  for (let repetition = 1; repetition <= 1; repetition += 1) {
    const subject = `phase3race${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const oldContent = `[about: ${subject}] Backend preference is Node.js. ${RUN_ID} race old ${repetition}`;
    const python = `[about: ${subject}] Backend preference is Python. ${RUN_ID} race python ${repetition}`;
    const java = `[about: ${subject}] Backend preference is Java. ${RUN_ID} race java ${repetition}`;
    const old = await createMemory(USER_A, "preference", oldContent);
    assert.ok(old);
    const requested = [python, python, python, java, java];
    const label = `B2_competing_supersede_r${repetition}`;
    const results = await runBatch(label, 5, requested.map((content) => () =>
      supersedeMemory(USER_A, old.id, "preference", content)
    ));
    assert.ok(results.every((result) => result.ok), label);
    assert.ok(results.every((result) => ["superseded", "stale_target"].includes(result.value.status)), label);
    const superseded = results.filter((result) => result.value.status === "superseded");
    assert.ok(superseded.length > 0, label);
    assert.equal(new Set(superseded.map((result) => result.value.memory.id)).size, 1, label);
    const active = await activeSubjectPreferences(USER_A, subject);
    assert.equal(active.length, 1, label);
    const winner = active[0].content.includes("Python") ? "Python" : "Java";
    const loser = winner === "Python" ? java : python;
    assert.equal(await exactContentCount(USER_A, "preference", loser), 0);
    assert.equal((await readMemory(old.id)).is_active, false);
    assert.equal(await exactContentCount(USER_A, "fact", expectedHistory(oldContent)), 1);
    scenarios.push({
      case: "B2",
      label,
      width: 5,
      repetition,
      statuses: results.map((result) => result.value.status),
      winner,
      activeWinners: active.length,
      loserRows: 0,
      historyRows: 1
    });
  }
}

async function updateDeactivateScenarios() {
  for (let repetition = 1; repetition <= 1; repetition += 1) {
    const original = `I keep the Phase 3 update deactivate fixture ${RUN_ID} ${repetition}.`;
    const updated = `I updated the Phase 3 update deactivate fixture ${RUN_ID} ${repetition}.`;
    const created = await createMemory(USER_A, "fact", original);
    assert.ok(created);
    const label = `C1_update_deactivate_r${repetition}`;
    const results = await runBatch(label, 2, [
      () => updateMemory(USER_A, created.id, updated),
      () => deactivateMemory(USER_A, created.id)
    ]);
    assert.ok(results.every((result) => result.ok), label);
    assert.ok(["updated", "not_found"].includes(results[0].value.status), label);
    assert.equal(results[1].value, true, label);
    const row = await readMemory(created.id);
    assert.equal(row.user_id, USER_A);
    assert.equal(row.is_active, false);
    assert.ok([original, updated].includes(row.content), label);
    assert.ok(row.updated_at >= row.created_at, label);
    scenarios.push({
      case: "C1",
      label,
      width: 2,
      repetition,
      updateStatus: results[0].value.status,
      deactivateResult: results[1].value,
      finalActive: row.is_active,
      finalContentMatchedRequest: true
    });
  }

  for (let repetition = 1; repetition <= 1; repetition += 1) {
    const original = `I keep the Phase 3 concurrent update fixture ${RUN_ID} ${repetition}.`;
    const updates = Array.from({ length: 5 }, (_, index) =>
      `I updated the Phase 3 concurrent update fixture ${RUN_ID} ${repetition} variant ${index}.`
    );
    const created = await createMemory(USER_A, "fact", original);
    assert.ok(created);
    const label = `C2_concurrent_updates_r${repetition}`;
    const results = await runBatch(label, 5, updates.map((content) => () =>
      updateMemory(USER_A, created.id, content)
    ));
    assert.ok(results.every((result) => result.ok && result.value.status === "updated"), label);
    const row = await readMemory(created.id);
    assert.equal(row.is_active, true);
    assert.equal(row.user_id, USER_A);
    assert.ok(updates.includes(row.content), label);
    scenarios.push({
      case: "C2",
      label,
      width: 5,
      repetition,
      updatedResults: results.length,
      finalActive: row.is_active,
      finalContentMatchedRequest: true
    });
  }
}

async function temporaryPermanentScenarios() {
  for (let repetition = 1; repetition <= 1; repetition += 1) {
    const content = `I keep the Phase 3 expiry fixture ${RUN_ID} ${repetition}.`;
    const expiryOne = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const expiryTwo = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
    const requests = [
      { expiresAt: null },
      { expiresAt: null },
      { expiresAt: expiryOne },
      { expiresAt: expiryOne },
      { expiresAt: expiryTwo },
      { expiresAt: expiryTwo }
    ];
    const label = `D_expiry_identity_r${repetition}`;
    const results = await runBatch(label, 6, requests.map((options) => () =>
      createMemory(USER_A, "commitment", content, options)
    ));
    assert.ok(results.every((result) => result.ok && result.value), label);
    const permanentIds = new Set(results.slice(0, 2).map((result) => result.value.id));
    const temporaryOneIds = new Set(results.slice(2, 4).map((result) => result.value.id));
    const temporaryTwoIds = new Set(results.slice(4, 6).map((result) => result.value.id));
    assert.equal(permanentIds.size, 1);
    assert.equal(temporaryOneIds.size, 1);
    assert.equal(temporaryTwoIds.size, 1);
    assert.equal(new Set([...permanentIds, ...temporaryOneIds, ...temporaryTwoIds]).size, 3);

    const permanent = await readMemory([...permanentIds][0]);
    const temporaryOne = await readMemory([...temporaryOneIds][0]);
    const temporaryTwo = await readMemory([...temporaryTwoIds][0]);
    assert.equal(permanent.expires_at, null);
    assert.equal(temporaryOne.expires_at.toISOString(), expiryOne);
    assert.equal(temporaryTwo.expires_at.toISOString(), expiryTwo);

    const permanentUpdate = `I updated the Phase 3 permanent expiry fixture ${RUN_ID} ${repetition}.`;
    const temporaryUpdate = `I updated the Phase 3 temporary expiry fixture ${RUN_ID} ${repetition}.`;
    const updateResults = await runBatch(`${label}_updates`, 2, [
      () => updateMemory(USER_A, permanent.id, permanentUpdate),
      () => updateMemory(USER_A, temporaryOne.id, temporaryUpdate)
    ]);
    assert.ok(updateResults.every((result) => result.ok && result.value.status === "updated"));
    assert.equal((await readMemory(permanent.id)).expires_at, null);
    assert.equal((await readMemory(temporaryOne.id)).expires_at.toISOString(), expiryOne);
    assert.equal((await readMemory(permanent.id)).content, permanentUpdate);
    assert.equal((await readMemory(temporaryOne.id)).content, temporaryUpdate);
    assert.equal((await readMemory(temporaryTwo.id)).content, content);
    scenarios.push({
      case: "D",
      label,
      width: 6,
      repetition,
      uniqueIdentityRows: 3,
      permanentExpiry: null,
      temporaryExpiryPreserved: true,
      crossRecordUpdates: 0
    });
  }
}

async function crossUserScenarios() {
  const content = `I keep the Phase 3 cross-user fixture ${RUN_ID}.`;
  const operations = [
    ...Array.from({ length: 3 }, () => () => createMemory(USER_A, "fact", content)),
    ...Array.from({ length: 2 }, () => () => createMemory(USER_B, "fact", content))
  ];
  const results = await runBatch("E_cross_user_duplicate_creates", 5, operations);
  assert.ok(results.every((result) => result.ok && result.value));
  const userAIds = new Set(results.slice(0, 3).map((result) => result.value.id));
  const userBIds = new Set(results.slice(3).map((result) => result.value.id));
  assert.equal(userAIds.size, 1);
  assert.equal(userBIds.size, 1);
  const memoryAId = [...userAIds][0];
  const memoryBId = [...userBIds][0];
  assert.notEqual(memoryAId, memoryBId);
  assert.equal(await getMemoryById(USER_B, memoryAId), null);
  assert.equal(await getMemoryById(USER_A, memoryBId), null);

  const updated = `I updated the Phase 3 cross-user fixture ${RUN_ID}.`;
  const mixedResults = await runBatch("E_cross_user_mixed_operations", 6, [
    () => updateMemory(USER_A, memoryAId, updated),
    () => updateMemory(USER_B, memoryAId, `I cannot update another user's ${RUN_ID} fixture.`),
    () => deactivateMemory(USER_B, memoryAId),
    () => supersedeMemory(USER_B, memoryAId, "fact", `I cannot replace another user's ${RUN_ID} fixture.`),
    () => getUserMemories(USER_A, 100),
    () => getUserMemories(USER_B, 100)
  ]);
  assert.ok(mixedResults.every((result) => result.ok));
  assert.equal(mixedResults[0].value.status, "updated");
  assert.equal(mixedResults[1].value.status, "not_found");
  assert.equal(mixedResults[2].value, false);
  assert.equal(mixedResults[3].value.status, "invalid_target");
  assert.equal(mixedResults[4].value.some((memory) => memory.id === memoryBId), false);
  assert.equal(mixedResults[5].value.some((memory) => memory.id === memoryAId), false);
  assert.equal((await readMemory(memoryAId)).content, updated);
  assert.equal((await readMemory(memoryAId)).is_active, true);
  assert.equal((await readMemory(memoryBId)).content, content);
  assert.equal((await readMemory(memoryBId)).is_active, true);
  scenarios.push({
    case: "E",
    duplicateWidth: 5,
    mixedWidth: 6,
    ownerRows: 2,
    crossUserLeakage: 0,
    unauthorizedMutations: 0,
    authenticatedHttpConcurrency: cookieJarBytes() > 0 ? "NOT_ATTEMPTED" : "BLOCKED"
  });
}

async function rollbackAndRelease(client) {
  let rollbackFailure = null;
  try {
    await client.query("ROLLBACK");
  } catch (error) {
    rollbackFailure = error;
  }

  try {
    client.release(rollbackFailure);
  } catch (error) {
    throw new Error("PostgreSQL client release failed during rollback cleanup.", {
      cause: errorEvidence(error)
    });
  }

  if (rollbackFailure) {
    throw new Error("PostgreSQL rollback failed; client discarded.", {
      cause: errorEvidence(rollbackFailure)
    });
  }
}

async function waitingLockCount(pattern, backendPid) {
  const result = await auditPool.query(
    `SELECT count(*)::int AS count
     FROM pg_stat_activity
     WHERE pid = $2
       AND datname = current_database()
       AND wait_event_type = 'Lock'
       AND query ILIKE $1`,
    [`%${pattern}%`, backendPid]
  );
  return result.rows[0].count;
}

async function transactionScenarios() {
  const blockingContent = `I keep the Phase 3 advisory lock fixture ${RUN_ID}.`;
  const blocker = await auditPool.connect();
  let blockingOperation;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`memory:${USER_A}:user:fact`]
    );
    let settled = false;
    lastBackendPid = null;
    blockingOperation = execute("F1_advisory_lock_wait", () =>
      createMemory(USER_A, "fact", blockingContent)
    ).then((result) => {
      settled = true;
      return result;
    });
    await waitFor(
      async () => lastBackendPid
        ? (await waitingLockCount("pg_advisory_xact_lock", lastBackendPid)) > 0
        : false,
      5000,
      "the repository backend waiting on the advisory lock"
    );
    assert.equal(settled, false);
  } finally {
    await rollbackAndRelease(blocker);
  }
  const blockingResult = await blockingOperation;
  assert.ok(blockingResult.ok && blockingResult.value);
  scenarios.push({
    case: "F1",
    realAdvisoryWaitObserved: true,
    releasedByRollback: true,
    result: "created"
  });

  const isolatedSubject = `phase3scope${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const scopeBlocker = await auditPool.connect();
  let isolatedOperation;
  try {
    await scopeBlocker.query("BEGIN");
    await scopeBlocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`memory:${USER_A}:${isolatedSubject}:preference`]
    );
    isolatedOperation = execute("F2_lock_scope_isolation", () => createMemory(
      USER_B,
      "preference",
      `[about: ${isolatedSubject}] Backend preference is Rust. ${RUN_ID} scope`
    ));
    let timer;
    try {
      const result = await Promise.race([
        isolatedOperation,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Different-user lock scope unexpectedly blocked.")), 3000);
        })
      ]);
      assert.ok(result.ok && result.value);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rollbackAndRelease(scopeBlocker);
  }
  await isolatedOperation;
  scenarios.push({
    case: "F2",
    differentUserScopeBlocked: false,
    result: "created"
  });

  const deadlockOriginal = `I keep the Phase 3 deadlock fixture ${RUN_ID}.`;
  const deadlockUpdated = `I updated the Phase 3 deadlock fixture ${RUN_ID}.`;
  const deadlockTarget = await createMemory(USER_A, "fact", deadlockOriginal);
  assert.ok(deadlockTarget);
  let deadlockBlocker = await auditPool.connect();
  let deadlockOperation;
  try {
    await deadlockBlocker.query("BEGIN");
    await deadlockBlocker.query("SELECT id FROM memories WHERE id = $1 FOR UPDATE", [deadlockTarget.id]);
    lastBackendPid = null;
    deadlockOperation = execute("F3_controlled_deadlock", () =>
      updateMemory(USER_A, deadlockTarget.id, deadlockUpdated)
    );
    await waitFor(async () => {
      if (!lastBackendPid) {
        return false;
      }
      const result = await auditPool.query(
        `SELECT count(*)::int AS count
         FROM pg_stat_activity
         WHERE pid = $1
           AND datname = current_database()
           AND wait_event_type = 'Lock'`,
        [lastBackendPid]
      );
      return result.rows[0].count > 0;
    }, 5000, "the repository update waiting on the target row");

    let blockerError = null;
    try {
      await deadlockBlocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`memory:${USER_A}:user:fact`]
      );
    } catch (error) {
      blockerError = errorEvidence(error);
    }
    const deadlockResult = await deadlockOperation;
    const resultCode = deadlockResult.ok ? null : deadlockResult.error.code;
    assert.ok(blockerError?.code === "40P01" || resultCode === "40P01");

    const blocker = deadlockBlocker;
    deadlockBlocker = null;
    await rollbackAndRelease(blocker);

    let row = await readMemory(deadlockTarget.id);
    if (deadlockResult.ok) {
      assert.equal(blockerError?.code, "40P01");
      assert.equal(row.content, deadlockUpdated);
      assert.equal(row.is_active, true);
    } else {
      assert.equal(resultCode, "40P01");
      assert.equal(row.content, deadlockOriginal);
      assert.equal(row.is_active, true);
      const retry = await updateMemory(USER_A, deadlockTarget.id, deadlockUpdated);
      assert.equal(retry.status, "updated");
      row = await readMemory(deadlockTarget.id);
      assert.equal(row.content, deadlockUpdated);
    }
    scenarios.push({
      case: "F3",
      controlledDeadlock: true,
      sqlstates: [blockerError?.code, resultCode].filter(Boolean),
      repositoryVictim: !deadlockResult.ok,
      finalActive: row.is_active,
      retryAfterRollback: !deadlockResult.ok
    });
  } finally {
    if (deadlockBlocker) {
      await rollbackAndRelease(deadlockBlocker);
    }
  }
  await deadlockOperation;
  await serializationScenario();
}

async function serializationScenario() {
  const serializationOriginal = `I keep the Phase 3 serialization fixture ${RUN_ID}.`;
  const serializationWinner = `I won the Phase 3 serialization fixture ${RUN_ID}.`;
  const serializationLoser = `I lost the Phase 3 serialization fixture ${RUN_ID}.`;
  const serializationTarget = await createMemory(USER_A, "fact", serializationOriginal);
  assert.ok(serializationTarget);
  const directPool = new pg.Pool({
    ...getIntegrationDatabaseConfig(process.env, { direct: true }),
    max: 2
  });
  let first = null;
  let second = null;
  let secondPid;
  let serializationError = null;
  let losingSettled = false;
  try {
    first = await directPool.connect();
    second = await directPool.connect();
    const pidResult = await second.query("SELECT pg_backend_pid() AS pid");
    secondPid = pidResult.rows[0].pid;
    await first.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await second.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await first.query(
      "UPDATE memories SET content = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2",
      [serializationTarget.id, USER_A, serializationWinner]
    );
    const losingUpdate = second.query(
      "UPDATE memories SET content = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2",
      [serializationTarget.id, USER_A, serializationLoser]
    ).catch((error) => {
      serializationError = errorEvidence(error);
      return null;
    }).finally(() => {
      losingSettled = true;
    });
    await waitFor(async () => {
      if (losingSettled) {
        return true;
      }
      const result = await auditPool.query(
        `SELECT count(*)::int AS count
         FROM pg_stat_activity
         WHERE pid = $1
           AND datname = current_database()
           AND wait_event_type = 'Lock'`,
        [secondPid]
      );
      return result.rows[0].count > 0;
    }, 5000, "a serialization conflict or serializable lock wait");
    await first.query("COMMIT");
    assert.equal(await losingUpdate, null);
    assert.equal(serializationError?.code, "40001");
    assert.equal((await readMemory(serializationTarget.id)).content, serializationWinner);
    scenarios.push({
      case: "F4",
      isolation: "SERIALIZABLE",
      connectionMode: "direct",
      directConnections: 2,
      sqlstates: [serializationError.code],
      finalContent: "committed_winner",
      retryImplemented: false
    });
  } finally {
    const cleanupFailures = [];
    for (const client of [first, second]) {
      if (!client) {
        continue;
      }
      try {
        await rollbackAndRelease(client);
      } catch (error) {
        cleanupFailures.push(errorEvidence(error));
      }
    }
    first = null;
    second = null;
    try {
      await directPool.end();
    } catch (error) {
      cleanupFailures.push(errorEvidence(error));
    }
    if (cleanupFailures.length > 0) {
      throw new Error("Phase 3 serialization cleanup failed.", {
        cause: cleanupFailures[0]
      });
    }
  }
}

async function finalAudit() {
  const actualCases = [...new Set(scenarios.map((scenario) => scenario.case))].sort();
  assert.deepEqual(
    actualCases,
    [...EXPECTED_SCENARIO_CASES].sort(),
    `Scenario coverage mismatch for ${RUN_MODE}`
  );

  const current = await readPreservationState();
  assert.equal(hash(current.users), hash(baseline.users));
  assert.equal(hash(current.sessions), hash(baseline.sessions));
  for (const key of ["conversations", "memories", "messages", "reminders", "toolLogs"]) {
    assert.equal(
      hash(filterByIds(current[key], baselineIds[key])),
      hash(baseline[key]),
      `${key} baseline rows changed`
    );
  }

  const counts = await readCounts();
  assert.equal(counts.auth_users, 6);
  assert.equal(counts.auth_sessions, 12);
  assert.equal(counts.conversations, baseline.conversations.length);
  assert.equal(counts.messages, baseline.messages.length);
  assert.equal(counts.reminders, 0);
  assert.equal(counts.agent_tool_logs, 0);

  const newMemories = current.memories.filter((memory) => !baselineIds.memories.has(memory.id));
  assert.ok(newMemories.length > 0);
  assert.ok(newMemories.every((memory) => [USER_A, USER_B].includes(memory.user_id)));
  assert.ok(newMemories.every((memory) => memory.content.toLowerCase().includes(RUN_ID.toLowerCase())));

  const duplicateResult = await auditPool.query(
    `SELECT count(*)::int AS count
     FROM (
       SELECT user_id, memory_type,
              trim(regexp_replace(lower(content), '[^a-z0-9]+', ' ', 'g')) AS normalized,
              expires_at
       FROM memories
       WHERE is_active = TRUE
         AND lower(content) LIKE $1
       GROUP BY user_id, memory_type, normalized, expires_at
       HAVING count(*) > 1
     ) duplicates`,
    [`%${RUN_ID.toLowerCase()}%`]
  );
  assert.equal(duplicateResult.rows[0].count, 0);

  const historyResult = await auditPool.query(
    `SELECT count(*)::int AS count
     FROM (
       SELECT user_id,
              trim(regexp_replace(lower(content), '[^a-z0-9]+', ' ', 'g')) AS normalized
       FROM memories
       WHERE memory_type = 'fact'
         AND content LIKE '%Previous preference:%'
         AND lower(content) LIKE $1
       GROUP BY user_id, normalized
       HAVING count(*) > 1
     ) duplicates`,
    [`%${RUN_ID.toLowerCase()}%`]
  );
  assert.equal(historyResult.rows[0].count, 0);

  const activeCategoryGroups = new Map();
  for (const memory of newMemories) {
    if (memory.memory_type !== "preference" || !memory.is_active || memory.expires_at !== null) {
      continue;
    }
    const attribution = analyzeMemoryAttribution(memory.content);
    const category = getPreferenceCategory(memory.content);
    if (attribution.ambiguous || !category) {
      continue;
    }
    const key = `${memory.user_id}:${attribution.subject}:${category}`;
    activeCategoryGroups.set(key, (activeCategoryGroups.get(key) || 0) + 1);
  }
  assert.ok([...activeCategoryGroups.values()].every((count) => count <= 1));

  const sourceViolations = await auditPool.query(
    `SELECT count(*)::int AS count
     FROM memories m
     LEFT JOIN messages msg ON msg.id = m.source_message_id
     LEFT JOIN conversations c ON c.id = msg.conversation_id
     WHERE m.source_message_id IS NOT NULL
       AND (msg.id IS NULL OR c.user_id <> m.user_id)`
  );
  assert.equal(sourceViolations.rows[0].count, 0);
  assert.equal(activeClients, 0);
  assert.equal(acquiredClients, releasedClients);
  assert.equal(pool.waitingCount, 0);
  assert.equal(auditActiveClients, 0);
  assert.equal(auditAcquiredClients, auditReleasedClients);
  assert.equal(auditPool.waitingCount, 0);

  console.log(JSON.stringify({
    check: "phase3_concurrency_final_audit",
    runId: RUN_ID,
    runMode: RUN_MODE,
    baselineCounts: {
      authUsers: baseline.users.length,
      authSessions: baseline.sessions.length,
      conversations: baseline.conversations.length,
      memories: baseline.memories.length,
      activeMemories: baseline.memories.filter((memory) => memory.is_active).length,
      messages: baseline.messages.length,
      reminders: baseline.reminders.length,
      agentToolLogs: baseline.toolLogs.length
    },
    finalCounts: counts,
    newMemoryCount: newMemories.length,
    preExistingRowsUnchanged: true,
    usersAndSessionsUnchanged: true,
    duplicateActiveLogicalRows: duplicateResult.rows[0].count,
    duplicateHistoryRows: historyResult.rows[0].count,
    invalidActiveCategoryGroups: [...activeCategoryGroups.values()].filter((count) => count > 1).length,
    sourceOwnershipViolations: sourceViolations.rows[0].count,
    pool: {
      acquiredClients,
      releasedClients,
      activeClients,
      waitingCount: pool.waitingCount,
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      uniqueBackendPids: new Set(backendPids).size
    },
    auditPool: {
      acquiredClients: auditAcquiredClients,
      releasedClients: auditReleasedClients,
      activeClients: auditActiveClients,
      waitingCount: auditPool.waitingCount,
      totalCount: auditPool.totalCount,
      idleCount: auditPool.idleCount,
      uniqueBackendPids: new Set(auditBackendPids).size
    },
    sqlstates: [...sqlstates].sort(),
    scenarios,
    batches,
    authenticatedHttpConcurrency: cookieJarBytes() > 0 ? "NOT_ATTEMPTED" : "BLOCKED",
    groqLlmConcurrency: "BLOCKED"
  }, null, 2));
}

before(async () => {
  const { default: repositoryPool } = await import("../src/config/database.js");
  pool = repositoryPool;
  const repository = await import("../src/repositories/memory.repository.js");
  ({
    createMemory,
    deactivateMemory,
    getMemoryById,
    getUserMemories,
    supersedeMemory,
    updateMemory
  } = repository);
  originalConnect = pool.connect.bind(pool);
  instrumentPoolConnect(pool, originalConnect, {
    acquire() {
      activeClients += 1;
      acquiredClients += 1;
    },
    async ready(client) {
      const pidResult = await client.query("SELECT pg_backend_pid() AS pid");
      lastBackendPid = pidResult.rows[0].pid;
      backendPids.push(lastBackendPid);
      if (connectGate) {
        connectGate.arrived += 1;
        connectGate.peakActive = Math.max(connectGate.peakActive, activeClients);
        if (connectGate.arrived === connectGate.expected) {
          connectGate.resolve();
        }
        await connectGate.promise;
      }
    },
    release() {
      activeClients -= 1;
      releasedClients += 1;
    }
  });

  await preflight();
});

after(async () => {
  if (pool && originalConnect) {
    pool.connect = originalConnect;
  }
  auditPool.connect = originalAuditConnect;
  await Promise.all([pool ? pool.end() : Promise.resolve(), auditPool.end()]);
});

test(`Phase 3 real PostgreSQL memory concurrency (${RUN_MODE})`, async () => {
  if (ONLY_F4) {
    await serializationScenario();
  } else {
    if (RUN_DUPLICATE_CREATION) {
      await duplicateCreationScenarios();
    }
    await supersedeScenarios();
    await updateDeactivateScenarios();
    await temporaryPermanentScenarios();
    await crossUserScenarios();
    await transactionScenarios();
  }
  await finalAudit();
});
