import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import dotenv from "dotenv";
import pg from "pg";

import { APPROVED_INTEGRATION_TARGET } from "./integration-env.js";

function replaceEnvironment(t, values) {
  const previousValues = new Map();

  for (const [name, value] of Object.entries(values)) {
    previousValues.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  t.after(() => {
    for (const [name, value] of previousValues) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
}

function mockPool(t) {
  t.mock.method(dotenv, "config", () => ({ parsed: {} }));
  const state = {
    configurations: [],
    connectAttempts: 0,
    queryAttempts: 0,
    endAttempts: 0,
    instance: null
  };

  t.mock.method(pg, "Pool", function MockPool(config) {
    state.configurations.push(config);
    state.instance = this;
    this.connect = async () => {
      state.connectAttempts += 1;
      throw new Error("Unit tests must not connect to PostgreSQL.");
    };
    this.query = async () => {
      state.queryAttempts += 1;
      throw new Error("Unit tests must not query PostgreSQL.");
    };
    this.end = async () => {
      state.endAttempts += 1;
    };
  });

  return state;
}

async function importDatabaseModule() {
  const module = await import(`./database.js?unit=${randomUUID()}`);
  return module.default;
}

test("constructs the ordinary pool without connecting or querying", async (t) => {
  const connectionString = "postgresql://unit_user:unit_password@unit.invalid:5432/unitdb";
  replaceEnvironment(t, {
    INTEGRATION_MODE: "false",
    NODE_ENV: "test",
    DATABASE_URL_POOLED: connectionString
  });
  const state = mockPool(t);

  const pool = await importDatabaseModule();

  assert.equal(pool, state.instance);
  assert.deepEqual(state.configurations, [{ connectionString, ssl: false }]);
  assert.equal(state.connectAttempts, 0);
  assert.equal(state.queryAttempts, 0);
  assert.equal(state.endAttempts, 0);
});

test("constructs the integration pool from sanitized settings without connecting", async (t) => {
  replaceEnvironment(t, {
    INTEGRATION_MODE: "true",
    NODE_ENV: "test",
    PGOPTIONS: undefined,
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
    TEST_NEON_AUTH_HOST: APPROVED_INTEGRATION_TARGET.authHost
  });
  const state = mockPool(t);

  const pool = await importDatabaseModule();

  assert.equal(pool, state.instance);
  assert.deepEqual(state.configurations, [{
    host: APPROVED_INTEGRATION_TARGET.databaseHost,
    port: "5432",
    database: "neondb",
    user: "test_user",
    password: "test_password",
    ssl: { rejectUnauthorized: true },
    sslnegotiation: "postgres",
    options: " "
  }]);
  assert.equal(Object.hasOwn(state.configurations[0], "connectionString"), false);
  assert.equal(state.connectAttempts, 0);
  assert.equal(state.queryAttempts, 0);
  assert.equal(state.endAttempts, 0);
});
