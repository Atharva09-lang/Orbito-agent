import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getIntegrationDatabaseConfig } from "../src/config/integration-env.js";

const USER_A_ID = process.env.TEST_MEMORY_OWNERSHIP_USER_A_ID;
const USER_B_ID = process.env.TEST_MEMORY_OWNERSHIP_USER_B_ID;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

assert.equal(process.env.INTEGRATION_MODE, "true", "Approved isolated integration mode is required.");
getIntegrationDatabaseConfig();
assert.ok(USER_A_ID && UUID_PATTERN.test(USER_A_ID), "A dedicated User A fixture ID is required.");
assert.ok(USER_B_ID && UUID_PATTERN.test(USER_B_ID), "A dedicated User B fixture ID is required.");
assert.notEqual(USER_A_ID, USER_B_ID, "Ownership fixtures must use distinct user IDs.");

const fixtureManifest = JSON.parse(readFileSync(
  process.env.TEST_MEMORY_OWNERSHIP_FIXTURE_FILE ??
    new URL("../phase2-identities.integration.local.json", import.meta.url),
  "utf8"
));
assert.equal(USER_A_ID, fixtureManifest.userAId, "User A must be the dedicated integration fixture.");
assert.equal(USER_B_ID, fixtureManifest.userBId, "User B must be the dedicated integration fixture.");

const { default: pool } = await import("../src/config/database.js");
const {
  createMemory,
  deactivateMemory,
  getMemoryById,
  updateMemory
} = await import("../src/repositories/memory.repository.js");

let memoryId;

try {
  const memory = await createMemory(
    USER_A_ID,
    "fact",
    `Temporary ownership security test ${randomUUID()}.`
  );
  assert.ok(memory?.id, "Could not create the ownership fixture memory.");
  memoryId = memory.id;

  const ownerState = await getMemoryById(USER_A_ID, memoryId);
  assert.equal(ownerState?.id, memoryId, "User A must be able to read the created memory directly by ID.");

  const userBMemory = await getMemoryById(USER_B_ID, memoryId);
  assert.equal(userBMemory, null, "User B must not read User A's memory.");

  const updateResult = await updateMemory(USER_B_ID, memoryId, "Unauthorized update attempt.");
  const deleteResult = await deactivateMemory(USER_B_ID, memoryId);
  const ownerStateAfterAttempts = await getMemoryById(USER_A_ID, memoryId);

  assert.deepEqual(
    ownerStateAfterAttempts,
    ownerState,
    "Unauthorized update and delete attempts must not mutate User A's persisted memory."
  );
  assert.equal(updateResult?.status, "not_found", "User B must not update User A's memory.");
  assert.equal(deleteResult, false, "User B must not deactivate User A's memory.");

  console.log(JSON.stringify({
    check: "memory_ownership",
    memoryId,
    crossUserRead: userBMemory !== null,
    crossUserUpdate: updateResult.status,
    crossUserDeactivate: deleteResult
  }));
} finally {
  try {
    if (memoryId) {
      const cleanupResult = await deactivateMemory(USER_A_ID, memoryId);
      assert.equal(
        cleanupResult,
        true,
        "Owner cleanup must soft-delete the ownership fixture memory."
      );
    }
  } finally {
    await pool.end();
  }
}
