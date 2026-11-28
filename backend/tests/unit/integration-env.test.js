import assert from "node:assert/strict";
import { test } from "node:test";
import ConnectionParameters from "pg/lib/connection-parameters.js";

import {
  APPROVED_INTEGRATION_TARGET,
  getIntegrationDatabaseConfig,
  validateIntegrationEnvironment
} from "../../src/config/integration-env.js";

const DATABASE_HOST = APPROVED_INTEGRATION_TARGET.databaseHost;
const AUTH_HOST = APPROVED_INTEGRATION_TARGET.authHost;
const validEnv = {
  INTEGRATION_MODE: "true",
  DATABASE_URL_POOLED: `postgresql://test_user:test_password@${DATABASE_HOST}:5432/neondb?sslmode=verify-full&channel_binding=require`,
  NEON_AUTH_BASE_URL: APPROVED_INTEGRATION_TARGET.authBaseUrl,
  NEON_AUTH_JWKS_URL: APPROVED_INTEGRATION_TARGET.authJwksUrl,
  TEST_API_URL: "http://localhost:5000/api",
  TEST_NEON_AUTH_URL: APPROVED_INTEGRATION_TARGET.authBaseUrl,
  TEST_AUTH_ORIGIN: "http://localhost:5173",
  TEST_COOKIE_FILE: "./cookies.integration.local",
  TEST_NEON_PROJECT_ID: APPROVED_INTEGRATION_TARGET.projectId,
  TEST_NEON_BRANCH_ID: APPROVED_INTEGRATION_TARGET.branchId,
  TEST_NEON_DB_HOST: DATABASE_HOST,
  TEST_NEON_AUTH_HOST: AUTH_HOST,
};

function withDatabaseUrl(databaseUrl, overrides = {}) {
  return { ...validEnv, ...overrides, DATABASE_URL_POOLED: databaseUrl };
}

function withDatabaseQuery(search, overrides = {}) {
  const databaseUrl = new URL(validEnv.DATABASE_URL_POOLED);
  databaseUrl.search = search;
  return withDatabaseUrl(databaseUrl.toString(), overrides);
}

test("accepts a complete isolated integration environment and returns sanitized pool settings", () => {
  assert.doesNotThrow(() => validateIntegrationEnvironment(validEnv));
  const config = getIntegrationDatabaseConfig(validEnv);

  assert.deepEqual(config, {
    host: DATABASE_HOST,
    port: "5432",
    database: "neondb",
    user: "test_user",
    password: "test_password",
    ssl: { rejectUnauthorized: true },
    sslnegotiation: "postgres",
    options: " "
  });
  assert.equal(Object.hasOwn(config, "connectionString"), false);
});

test("accepts an approved database URL without explicit SSL query parameters", () => {
  const databaseUrl = new URL(validEnv.DATABASE_URL_POOLED);
  databaseUrl.search = "";
  const config = getIntegrationDatabaseConfig(withDatabaseUrl(databaseUrl.toString()));

  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
});

test("uses the trusted direct endpoint only after validating the pooled destination", () => {
  const config = getIntegrationDatabaseConfig(validEnv, { direct: true });

  assert.equal(config.host, APPROVED_INTEGRATION_TARGET.directDatabaseHost);
  assert.equal(config.port, "5432");
  assert.equal(config.database, "neondb");
  assert.equal(config.user, "test_user");
  assert.equal(config.password, "test_password");
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  assert.equal(Object.hasOwn(config, "connectionString"), false);
});

test("requires integration mode for database configuration", () => {
  assert.throws(
    () => getIntegrationDatabaseConfig({ ...validEnv, INTEGRATION_MODE: "false" }),
    /Approved isolated integration mode is required/
  );
});

test("does not affect non-integration environments", () => {
  assert.doesNotThrow(() => validateIntegrationEnvironment({}));
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

test("rejects an unapproved test project even when the database endpoint is approved", () => {
  assert.throws(
    () => validateIntegrationEnvironment({ ...validEnv, TEST_NEON_PROJECT_ID: "self-asserted-project" }),
    /approved Neon test project/
  );
});

test("rejects the production Auth endpoint", () => {
  const productionAuthHost = "ep-calm-violet-aophputx.neonauth.c-2.ap-southeast-1.aws.neon.tech";
  assert.throws(
    () => validateIntegrationEnvironment({
      ...validEnv,
      NEON_AUTH_BASE_URL: `https://${productionAuthHost}/neondb/auth`,
      NEON_AUTH_JWKS_URL: `https://${productionAuthHost}/neondb/auth/.well-known/jwks.json`,
      TEST_NEON_AUTH_URL: `https://${productionAuthHost}/neondb/auth`,
      TEST_NEON_AUTH_HOST: productionAuthHost,
    }),
    /production Auth endpoint/
  );
});

test("rejects a declared database endpoint mismatch", () => {
  assert.throws(
    () => validateIntegrationEnvironment({ ...validEnv, TEST_NEON_DB_HOST: "ep-other.example" }),
    /approved test endpoint/
  );
});

test("rejects an effective database host mismatch despite approved labels", () => {
  assert.throws(
    () => validateIntegrationEnvironment(withDatabaseUrl(
      "postgresql://test_user:test_password@ep-other.example:5432/neondb?sslmode=verify-full"
    )),
    /approved test endpoint/
  );
});

test("rejects an unapproved database port", () => {
  assert.throws(
    () => validateIntegrationEnvironment(withDatabaseUrl(
      `postgresql://test_user:test_password@${DATABASE_HOST}:5433/neondb?sslmode=verify-full`
    )),
    /approved test database port/
  );
});

test("rejects an unapproved database name", () => {
  assert.throws(
    () => validateIntegrationEnvironment(withDatabaseUrl(
      `postgresql://test_user:test_password@${DATABASE_HOST}:5432/otherdb?sslmode=verify-full`
    )),
    /approved test database/
  );
});

test("rejects a missing database user", () => {
  assert.throws(
    () => validateIntegrationEnvironment(withDatabaseUrl(
      `postgresql://:test_password@${DATABASE_HOST}:5432/neondb?sslmode=verify-full`
    )),
    /invalid or conflicting user/
  );
});

test("rejects missing database credentials", () => {
  assert.throws(
    () => validateIntegrationEnvironment(withDatabaseUrl(
      `postgresql://test_user@${DATABASE_HOST}:5432/neondb?sslmode=verify-full`
    )),
    /must include test database credentials/
  );
});

for (const [name, value] of [
  ["host", DATABASE_HOST],
  ["port", "5432"],
  ["database", "neondb"],
  ["user", "test_user"],
  ["password", "test_password"],
  ["ssl", "true"],
  ["sslcert", "/tmp/client.crt"],
  ["sslkey", "/tmp/client.key"],
  ["sslrootcert", "/tmp/root.crt"],
  ["sslnegotiation", "direct"]
]) {
  test(`rejects the ${name}= database query override`, () => {
    assert.throws(
      () => validateIntegrationEnvironment(withDatabaseQuery(`${name}=${value}`)),
      /forbidden query parameter/
    );
  });
}

test("rejects unsupported database query parameters without reflecting their names", () => {
  let message = "";

  try {
    validateIntegrationEnvironment(withDatabaseQuery("options=-c%20search_path%3Dpublic"));
  } catch (error) {
    message = error.message;
  }

  assert.match(message, /unsupported query parameter/);
  assert.equal(message.includes("options"), false);
});

test("rejects duplicate database query parameters", () => {
  assert.throws(
    () => validateIntegrationEnvironment(withDatabaseQuery("sslmode=verify-full&sslmode=disable")),
    /ambiguous duplicate parameters/
  );
});

test("rejects sslmode=disable", () => {
  assert.throws(
    () => validateIntegrationEnvironment(withDatabaseQuery("sslmode=disable")),
    /sslmode=verify-full/
  );
});

test("rejects sslmode=no-verify", () => {
  assert.throws(
    () => validateIntegrationEnvironment(withDatabaseQuery("sslmode=no-verify")),
    /sslmode=verify-full/
  );
});

test("rejects an unsupported channel_binding value", () => {
  assert.throws(
    () => validateIntegrationEnvironment(withDatabaseQuery("channel_binding=prefer")),
    /unsupported channel_binding value/
  );
});

for (const [label, databaseUrl] of [
  ["a non-URL value", "not-a-connection-string"],
  ["a non-PostgreSQL scheme", "mysql://test_user:test_password@example.com/neondb"],
  ["a missing host", "postgresql:///neondb"],
  ["an empty authority host", `postgresql://test_user:test_password@:5432/neondb`],
  ["a URL fragment", `postgresql://test_user:test_password@${DATABASE_HOST}:5432/neondb#fragment`],
  ["an empty URL fragment", `postgresql://test_user:test_password@${DATABASE_HOST}:5432/neondb#`],
  ["malformed credential encoding", `postgresql://test_user:%ZZ@${DATABASE_HOST}:5432/neondb`]
]) {
  test(`rejects a malformed database connection string with ${label}`, () => {
    assert.throws(
      () => validateIntegrationEnvironment(withDatabaseUrl(databaseUrl)),
      /Invalid DATABASE_URL_POOLED|PostgreSQL URL/
    );
  });
}

test("does not expose credentials or connection strings in validation errors", () => {
  const secret = "do-not-print-this-password";
  const databaseUrl = `postgresql://test_user:${secret}@${DATABASE_HOST}:5432/neondb?host=ep-other.example`;
  let message = "";

  try {
    validateIntegrationEnvironment(withDatabaseUrl(databaseUrl));
  } catch (error) {
    message = error.message;
  }

  assert.match(message, /forbidden query parameter/);
  assert.equal(message.includes("host"), false);
  assert.equal(message.includes(secret), false);
  assert.equal(message.includes(databaseUrl), false);
});

test("rejects a non-local integration API endpoint", () => {
  assert.throws(
    () => validateIntegrationEnvironment({ ...validEnv, TEST_API_URL: "http://example.com/api" }),
    /local HTTP endpoint/
  );
});

test("rejects a mismatched JWKS path", () => {
  assert.throws(
    () => validateIntegrationEnvironment({
      ...validEnv,
      NEON_AUTH_JWKS_URL: `https://${AUTH_HOST}/other/auth/.well-known/jwks.json`,
    }),
    /JWKS URL does not match the configured Auth base URL/
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

test("rejects an invalid pooled destination even when direct mode is requested", () => {
  assert.throws(
    () => getIntegrationDatabaseConfig(withDatabaseUrl(
      `postgresql://test_user:test_password@${APPROVED_INTEGRATION_TARGET.directDatabaseHost}:5432/neondb?sslmode=verify-full`
    ), { direct: true }),
    /approved test endpoint/
  );
});

test("rejects ambient PGOPTIONS in integration mode", () => {
  assert.throws(
    () => validateIntegrationEnvironment({
      ...validEnv,
      PGOPTIONS: "-c search_path=untrusted"
    }),
    /PGOPTIONS is not allowed/
  );
});

test("sanitized settings override hostile PG variables in actual ConnectionParameters", (t) => {
  const hostileValues = {
    PGHOST: "attacker.invalid",
    PGPORT: "6543",
    PGDATABASE: "untrusted",
    PGUSER: "attacker",
    PGPASSWORD: "hostile-password",
    PGSSLMODE: "no-verify",
    PGSSLNEGOTIATION: "direct",
    PGOPTIONS: "-c search_path=untrusted"
  };
  const previousValues = new Map();

  for (const [name, value] of Object.entries(hostileValues)) {
    previousValues.set(name, process.env[name]);
    process.env[name] = value;
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

  const config = getIntegrationDatabaseConfig(validEnv);
  const parameters = new ConnectionParameters(config);

  assert.equal(parameters.host, DATABASE_HOST);
  assert.equal(parameters.port, 5432);
  assert.equal(parameters.database, "neondb");
  assert.equal(parameters.user, "test_user");
  assert.equal(parameters.password, "test_password");
  assert.deepEqual(parameters.ssl, { rejectUnauthorized: true });
  assert.equal(parameters.sslnegotiation, "postgres");
  assert.equal(parameters.options, " ");
});

for (const [label, databaseUrl] of [
  ["a raw newline", `postgresql://test_user:test_password@${DATABASE_HOST}:5432/neondb\n?sslmode=verify-full`],
  ["a raw tab", `postgresql://test_user:test_password@${DATABASE_HOST}:5432/neo\tdb?sslmode=verify-full`],
  ["a raw carriage return", `postgresql://test_user:test_password@${DATABASE_HOST}:5432/neondb\r?sslmode=verify-full`],
  ["a leading space", ` postgresql://test_user:test_password@${DATABASE_HOST}:5432/neondb?sslmode=verify-full`],
  ["a raw NUL", `postgresql://test_user:test_password@${DATABASE_HOST}:5432/neo\0db?sslmode=verify-full`]
]) {
  test(`rejects a database URL containing ${label}`, () => {
    assert.throws(
      () => validateIntegrationEnvironment(withDatabaseUrl(databaseUrl)),
      /Invalid DATABASE_URL_POOLED/
    );
  });
}

test("rejects encoded aliases for forbidden database query parameters", () => {
  assert.throws(
    () => validateIntegrationEnvironment(withDatabaseQuery("%68ost=attacker.invalid")),
    /forbidden query parameter/
  );
});

test("rejects encoded aliases for SSL mode overrides", () => {
  assert.throws(
    () => validateIntegrationEnvironment(withDatabaseQuery("%73slmode=disable")),
    /sslmode=verify-full/
  );
});

test("rejects duplicate database query parameters after percent decoding", () => {
  assert.throws(
    () => validateIntegrationEnvironment(withDatabaseQuery("sslmode=verify-full&%73slmode=disable")),
    /ambiguous duplicate parameters/
  );
});

for (const [label, host] of [
  ["an IPv6 host", "[::1]"],
  ["a trailing-dot host", `${DATABASE_HOST}.`]
]) {
  test(`rejects a database URL using ${label}`, () => {
    assert.throws(
      () => validateIntegrationEnvironment(withDatabaseUrl(
        `postgresql://test_user:test_password@${host}:5432/neondb?sslmode=verify-full`
      )),
      /approved test endpoint|Invalid DATABASE_URL_POOLED/
    );
  });
}

test("rejects a self-asserted wrong Auth tenant", () => {
  const wrongHost = "ep-other.neonauth.example";
  assert.throws(
    () => validateIntegrationEnvironment({
      ...validEnv,
      NEON_AUTH_BASE_URL: `https://${wrongHost}/neondb/auth`,
      NEON_AUTH_JWKS_URL: `https://${wrongHost}/neondb/auth/.well-known/jwks.json`,
      TEST_NEON_AUTH_URL: `https://${wrongHost}/neondb/auth`,
      TEST_NEON_AUTH_HOST: wrongHost
    }),
    /approved test Auth endpoint/
  );
});

test("rejects HTTP Auth URLs", () => {
  const baseUrl = APPROVED_INTEGRATION_TARGET.authBaseUrl.replace("https:", "http:");
  const jwksUrl = APPROVED_INTEGRATION_TARGET.authJwksUrl.replace("https:", "http:");
  assert.throws(
    () => validateIntegrationEnvironment({
      ...validEnv,
      NEON_AUTH_BASE_URL: baseUrl,
      NEON_AUTH_JWKS_URL: jwksUrl,
      TEST_NEON_AUTH_URL: baseUrl
    }),
    /must use HTTPS/
  );
});

test("rejects credentials in Auth URLs", () => {
  const authUrl = new URL(APPROVED_INTEGRATION_TARGET.authBaseUrl);
  authUrl.username = "attacker";
  authUrl.password = "secret";
  assert.throws(
    () => validateIntegrationEnvironment({
      ...validEnv,
      NEON_AUTH_BASE_URL: authUrl.href,
      TEST_NEON_AUTH_URL: authUrl.href
    }),
    /must not contain credentials, fragments, or query parameters/
  );
});

for (const [label, suffix] of [
  ["a fragment", "#fragment"],
  ["an unexpected query parameter", "?redirect=attacker.invalid"]
]) {
  test(`rejects an Auth base URL containing ${label}`, () => {
    const authUrl = `${APPROVED_INTEGRATION_TARGET.authBaseUrl}${suffix}`;
    assert.throws(
      () => validateIntegrationEnvironment({
        ...validEnv,
        NEON_AUTH_BASE_URL: authUrl,
        TEST_NEON_AUTH_URL: authUrl
      }),
      /must not contain credentials, fragments, or query parameters/
    );
  });
}

test("rejects a JWKS URL from a different Auth tenant", () => {
  assert.throws(
    () => validateIntegrationEnvironment({
      ...validEnv,
      NEON_AUTH_JWKS_URL: "https://ep-other.neonauth.example/neondb/auth/.well-known/jwks.json"
    }),
    /JWKS URL does not match the configured Auth base URL/
  );
});

test("rejects a TEST_NEON_AUTH_URL that disagrees with the pinned Auth base URL", () => {
  assert.throws(
    () => validateIntegrationEnvironment({
      ...validEnv,
      TEST_NEON_AUTH_URL: `${APPROVED_INTEGRATION_TARGET.authBaseUrl}/`
    }),
    /must match NEON_AUTH_BASE_URL/
  );
});

test("rejects a self-asserted TEST_NEON_AUTH_HOST", () => {
  assert.throws(
    () => validateIntegrationEnvironment({
      ...validEnv,
      TEST_NEON_AUTH_HOST: "ep-self-asserted.neonauth.example"
    }),
    /approved test Auth endpoint/
  );
});

test("rejects raw whitespace in Auth URLs before URL normalization", () => {
  assert.throws(
    () => validateIntegrationEnvironment({
      ...validEnv,
      NEON_AUTH_BASE_URL: `${APPROVED_INTEGRATION_TARGET.authBaseUrl}\n`,
      TEST_NEON_AUTH_URL: `${APPROVED_INTEGRATION_TARGET.authBaseUrl}\n`
    }),
    /Invalid NEON_AUTH_BASE_URL/
  );
});

test("requires the exact approved Auth base and JWKS URLs", () => {
  assert.throws(
    () => validateIntegrationEnvironment({
      ...validEnv,
      NEON_AUTH_BASE_URL: `${APPROVED_INTEGRATION_TARGET.authBaseUrl}/`,
      TEST_NEON_AUTH_URL: `${APPROVED_INTEGRATION_TARGET.authBaseUrl}/`
    }),
    /approved test Auth endpoint/
  );
});
