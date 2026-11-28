import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { APPROVED_INTEGRATION_TARGET } from "../../src/config/integration-env.js";
import { listDiscoverableTestFiles, PHASE_INTEGRATION_FILES } from "./suite-files.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(TEST_DIR, "../..");
const OWNERSHIP_SCRIPT = path.join(TEST_DIR, "../memory-ownership.integration.js");
const DATABASE_TEST = path.join(BACKEND_DIR, "src/config/database.test.js");
const NETWORK_GUARD = new URL("./no-external-network.js", import.meta.url).href;
const USER_A_ID = "11111111-1111-4111-8111-111111111111";
const USER_B_ID = "22222222-2222-4222-8222-222222222222";
const FIXTURE_DIRECTORY = mkdtempSync(path.join(tmpdir(), "orbito-ownership-unit-"));
const FIXTURE_MANIFEST = path.join(FIXTURE_DIRECTORY, "identities.json");
const AUTH_HOST = APPROVED_INTEGRATION_TARGET.authHost;
const VALID_OWNERSHIP_ENV = {
  INTEGRATION_MODE: "true",
  DATABASE_URL_POOLED: `postgresql://test_user:test_password@${APPROVED_INTEGRATION_TARGET.databaseHost}:5432/neondb?sslmode=verify-full&channel_binding=require`,
  NEON_AUTH_BASE_URL: APPROVED_INTEGRATION_TARGET.authBaseUrl,
  NEON_AUTH_JWKS_URL: APPROVED_INTEGRATION_TARGET.authJwksUrl,
  TEST_API_URL: "http://localhost:5000/api",
  TEST_NEON_AUTH_URL: APPROVED_INTEGRATION_TARGET.authBaseUrl,
  TEST_AUTH_ORIGIN: "http://localhost:5173",
  TEST_COOKIE_FILE: "./cookies.integration.local",
  TEST_NEON_PROJECT_ID: APPROVED_INTEGRATION_TARGET.projectId,
  TEST_NEON_BRANCH_ID: APPROVED_INTEGRATION_TARGET.branchId,
  TEST_NEON_DB_HOST: APPROVED_INTEGRATION_TARGET.databaseHost,
  TEST_NEON_AUTH_HOST: AUTH_HOST,
  TEST_MEMORY_OWNERSHIP_USER_A_ID: USER_A_ID,
  TEST_MEMORY_OWNERSHIP_USER_B_ID: USER_B_ID,
  TEST_MEMORY_OWNERSHIP_FIXTURE_FILE: FIXTURE_MANIFEST
};

writeFileSync(FIXTURE_MANIFEST, JSON.stringify({ userAId: USER_A_ID, userBId: USER_B_ID }));
after(() => {
  rmSync(FIXTURE_DIRECTORY, { recursive: true, force: true });
});

function runOwnershipScript(overrides = {}) {
  return spawnSync(process.execPath, [OWNERSHIP_SCRIPT], {
    cwd: BACKEND_DIR,
    env: { ...process.env, ...VALID_OWNERSHIP_ENV, ...overrides },
    encoding: "utf8",
    timeout: 10000
  });
}

test("guarded integration suites fail before Auth or database activity", () => {
  for (const file of PHASE_INTEGRATION_FILES) {
    const env = {
      ...process.env,
      INTEGRATION_MODE: "false",
      TEST_NETWORK_GUARD_REPORT: "true",
      NODE_OPTIONS: [`--import=${NETWORK_GUARD}`, process.env.NODE_OPTIONS].filter(Boolean).join(" ")
    };
    for (const name of [
      "DATABASE_URL",
      "DATABASE_URL_POOLED",
      "NEON_AUTH_BASE_URL",
      "NEON_AUTH_JWKS_URL",
      "TEST_NEON_AUTH_URL",
      "TEST_NEON_AUTH_HOST"
    ]) {
      delete env[name];
    }

    const result = spawnSync(process.execPath, [path.join(BACKEND_DIR, file)], {
      cwd: BACKEND_DIR,
      env,
      encoding: "utf8",
      timeout: 10000
    });

    assert.equal(result.status, 1, `${file}: ${result.stderr || result.stdout}`);
    assert.match(result.stderr, /Approved isolated integration mode is required/, file);
    assert.match(result.stdout, /EXTERNAL_NETWORK_ATTEMPTS=0/, file);
    assert.doesNotMatch(result.stderr, /EXTERNAL_NETWORK_ATTEMPT count=[1-9]/, file);
  }
});

test("a failed suite preflight prevents every later write test body", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `
      import { after, before, test } from "node:test";

      let writes = 0;
      before(() => {
        throw new Error("preservation preflight failed");
      });
      test("first write scenario", () => {
        writes += 1;
      });
      test("second write scenario", () => {
        writes += 1;
      });
      after(() => {
        process.stdout.write("WRITES=" + writes + "\\n");
      });
    `],
    {
      cwd: BACKEND_DIR,
      encoding: "utf8",
      timeout: 10000
    }
  );

  assert.equal(result.status, 1, result.stderr || result.error?.message || result.stdout);
  assert.match(result.stdout, /WRITES=0/);
  assert.match(result.stdout, /hookFailed/);
});

test("default discovery scans source trees and singular test directories", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "orbito-discovery-unit-"));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(path.join(directory, "src/config"), { recursive: true });
  mkdirSync(path.join(directory, "test/nested"), { recursive: true });
  mkdirSync(path.join(directory, "node_modules/example"), { recursive: true });
  writeFileSync(path.join(directory, "src/config/database.test.js"), "");
  writeFileSync(path.join(directory, "src/config/helper.js"), "");
  writeFileSync(path.join(directory, "test/nested/smoke.js"), "");
  writeFileSync(path.join(directory, "node_modules/example/ignored.test.js"), "");

  const discovered = listDiscoverableTestFiles(directory);

  assert.equal(discovered.includes(path.join(directory, "src/config/database.test.js")), true);
  assert.equal(discovered.includes(path.join(directory, "test/nested/smoke.js")), true);
  assert.equal(discovered.includes(path.join(directory, "src/config/helper.js")), false);
  assert.equal(discovered.includes(path.join(directory, "node_modules/example/ignored.test.js")), false);
});

test("the source database test is discoverable and uses a mocked pool", () => {
  const discovered = listDiscoverableTestFiles(BACKEND_DIR);
  const source = readFileSync(DATABASE_TEST, "utf8");

  assert.equal(discovered.includes(DATABASE_TEST), true);
  assert.match(source, /t\.mock\.method\(pg, "Pool"/);
  assert.doesNotMatch(source, /await pool\.query/);
});

test("the standalone ownership script is outside default test discovery", () => {
  const testFiles = listDiscoverableTestFiles(BACKEND_DIR);

  assert.equal(testFiles.includes(path.join(BACKEND_DIR, "tests/memory-ownership.test.js")), false);
  assert.equal(testFiles.includes(OWNERSHIP_SCRIPT), false);
  assert.equal(existsSync(OWNERSHIP_SCRIPT), true);
});

test("the standalone ownership script fails before database imports when integration mode is missing", () => {
  const result = runOwnershipScript({ INTEGRATION_MODE: "false" });

  assert.equal(result.status, 1, result.stderr || result.error?.message || result.stdout);
  assert.match(result.stderr, /Approved isolated integration mode is required/);
  assert.equal(result.stdout, "");
});

test("the standalone ownership script rejects a mismatched User A fixture before database imports", () => {
  const result = runOwnershipScript({
    TEST_MEMORY_OWNERSHIP_USER_A_ID: "33333333-3333-4333-8333-333333333333"
  });

  assert.equal(result.status, 1, result.stderr || result.error?.message || result.stdout);
  assert.match(result.stderr, /User A must be the dedicated integration fixture/);
  assert.equal(result.stdout, "");
});

test("the standalone ownership script rejects a mismatched User B fixture before database imports", () => {
  const result = runOwnershipScript({
    TEST_MEMORY_OWNERSHIP_USER_B_ID: "44444444-4444-4444-8444-444444444444"
  });

  assert.equal(result.status, 1, result.stderr || result.error?.message || result.stdout);
  assert.match(result.stderr, /User B must be the dedicated integration fixture/);
  assert.equal(result.stdout, "");
});

test("the standalone ownership script rejects identical fixture IDs before database imports", () => {
  const result = runOwnershipScript({
    TEST_MEMORY_OWNERSHIP_USER_A_ID: USER_A_ID,
    TEST_MEMORY_OWNERSHIP_USER_B_ID: USER_A_ID
  });

  assert.equal(result.status, 1, result.stderr || result.error?.message || result.stdout);
  assert.match(result.stderr, /Ownership fixtures must use distinct user IDs/);
  assert.equal(result.stdout, "");
});
