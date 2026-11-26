import { test } from "node:test";
import assert from "node:assert/strict";

import { validateIntegrationEnvironment } from "../../src/config/integration-env.js";

const validEnv = {
  INTEGRATION_MODE: "true",
  DATABASE_URL_POOLED: "postgresql://user:pass@ep-test-pooler.example:5432/neondb",
  NEON_AUTH_BASE_URL: "https://ep-test.neonauth.example/neondb/auth",
  NEON_AUTH_JWKS_URL: "https://ep-test.neonauth.example/neondb/auth/.well-known/jwks.json",
  TEST_API_URL: "http://localhost:5000/api",
  TEST_NEON_AUTH_URL: "https://ep-test.neonauth.example/neondb/auth",
  TEST_AUTH_ORIGIN: "http://localhost:5173",
  TEST_COOKIE_FILE: "./cookies.integration.local",
  TEST_NEON_PROJECT_ID: "test-project-123",
  TEST_NEON_BRANCH_ID: "br-test-123",
  TEST_NEON_DB_HOST: "ep-test-pooler.example",
  TEST_NEON_AUTH_HOST: "ep-test.neonauth.example",
};

test("accepts a complete isolated integration environment", () => {
  assert.doesNotThrow(() => validateIntegrationEnvironment(validEnv));
});

test("rejects the production project ID", () => {
  assert.throws(
    () => validateIntegrationEnvironment({ ...validEnv, TEST_NEON_PROJECT_ID: "winter-math-54988029" }),
    /production Neon project/
  );
});

test("rejects the production branch ID", () => {
  assert.throws(
    () => validateIntegrationEnvironment({ ...validEnv, TEST_NEON_BRANCH_ID: "br-restless-silence-ao5ra3rh" }),
    /production Neon project/
  );
});

test("rejects the production Auth endpoint", () => {
  assert.throws(
    () => validateIntegrationEnvironment({
      ...validEnv,
      NEON_AUTH_BASE_URL: "https://ep-calm-violet-aophputx.neonauth.c-2.ap-southeast-1.aws.neon.tech/neondb/auth",
      NEON_AUTH_JWKS_URL: "https://ep-calm-violet-aophputx.neonauth.c-2.ap-southeast-1.aws.neon.tech/neondb/auth/.well-known/jwks.json",
      TEST_NEON_AUTH_URL: "https://ep-calm-violet-aophputx.neonauth.c-2.ap-southeast-1.aws.neon.tech/neondb/auth",
      TEST_NEON_AUTH_HOST: "ep-calm-violet-aophputx.neonauth.c-2.ap-southeast-1.aws.neon.tech",
    }),
    /production Auth endpoint/
  );
});

test("rejects a database endpoint mismatch", () => {
  assert.throws(
    () => validateIntegrationEnvironment({ ...validEnv, TEST_NEON_DB_HOST: "ep-other.example" }),
    /approved test endpoint/
  );
});

test("rejects a mismatched JWKS path", () => {
  assert.throws(
    () => validateIntegrationEnvironment({
      ...validEnv,
      NEON_AUTH_JWKS_URL: "https://ep-test.neonauth.example/other/auth/.well-known/jwks.json",
    }),
    /does not belong/
  );
});

test("rejects the shared cookie jar", () => {
  assert.throws(
    () => validateIntegrationEnvironment({ ...validEnv, TEST_COOKIE_FILE: "./cookies.txt" }),
    /isolated integration cookie jar/
  );
});

test("rejects missing integration variables", () => {
  const env = { ...validEnv };
  delete env.TEST_NEON_BRANCH_ID;
  assert.throws(() => validateIntegrationEnvironment(env), /Missing TEST_NEON_BRANCH_ID/);
});

test("does not affect non-integration environments", () => {
  assert.doesNotThrow(() => validateIntegrationEnvironment({}));
});
