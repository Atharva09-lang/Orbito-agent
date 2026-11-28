import { parse } from "pg-connection-string";

const PRODUCTION_PROJECT_ID = "winter-math-54988029";
const PRODUCTION_BRANCH_ID = "br-restless-silence-ao5ra3rh";
const PRODUCTION_AUTH_HOST = "ep-calm-violet-aophputx.neonauth.c-2.ap-southeast-1.aws.neon.tech";

export const APPROVED_INTEGRATION_TARGET = Object.freeze({
  projectId: "odd-bread-81511600",
  branchId: "br-lively-tree-bi1z37kh",
  databaseHost: "ep-rough-king-bi6v85y5-pooler.c-5.ap-southeast-1.aws.neon.tech",
  directDatabaseHost: "ep-rough-king-bi6v85y5.c-5.ap-southeast-1.aws.neon.tech",
  databasePort: "5432",
  databaseName: "neondb",
  authHost: "ep-rough-king-bi6v85y5.neonauth.c-5.ap-southeast-1.aws.neon.tech",
  authBaseUrl: "https://ep-rough-king-bi6v85y5.neonauth.c-5.ap-southeast-1.aws.neon.tech/neondb/auth",
  authJwksUrl: "https://ep-rough-king-bi6v85y5.neonauth.c-5.ap-southeast-1.aws.neon.tech/neondb/auth/.well-known/jwks.json"
});

const REQUIRED_VARIABLES = [
  "DATABASE_URL_POOLED",
  "NEON_AUTH_BASE_URL",
  "NEON_AUTH_JWKS_URL",
  "TEST_API_URL",
  "TEST_NEON_AUTH_URL",
  "TEST_AUTH_ORIGIN",
  "TEST_COOKIE_FILE",
  "TEST_NEON_PROJECT_ID",
  "TEST_NEON_BRANCH_ID",
  "TEST_NEON_DB_HOST",
  "TEST_NEON_AUTH_HOST",
];

const FORBIDDEN_DATABASE_QUERY_PARAMETERS = new Set([
  "host",
  "port",
  "database",
  "user",
  "password",
  "ssl",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslnegotiation",
]);

const ALLOWED_DATABASE_QUERY_PARAMETERS = new Set([
  "sslmode",
  "channel_binding",
]);

const RAW_CONTROL_OR_WHITESPACE = /[\u0000-\u0020\u007f]/;

function parseUrl(value, name) {
  if (typeof value !== "string" || RAW_CONTROL_OR_WHITESPACE.test(value)) {
    throw new Error(`Invalid ${name} in integration environment.`);
  }

  try {
    return new URL(value);
  } catch {
    throw new Error(`Invalid ${name} in integration environment.`);
  }
}

export function getAuthVerificationConfig(env = process.env) {
  const authUrl = parseUrl(env.NEON_AUTH_BASE_URL, "NEON_AUTH_BASE_URL");
  const jwksUrl = parseUrl(env.NEON_AUTH_JWKS_URL, "NEON_AUTH_JWKS_URL");

  if (authUrl.protocol !== "https:" || jwksUrl.protocol !== "https:") {
    throw new Error("Neon Auth URLs must use HTTPS.");
  }
  if (
    authUrl.username ||
    authUrl.password ||
    jwksUrl.username ||
    jwksUrl.password ||
    authUrl.hash ||
    jwksUrl.hash ||
    env.NEON_AUTH_BASE_URL.includes("#") ||
    env.NEON_AUTH_JWKS_URL.includes("#") ||
    authUrl.search ||
    jwksUrl.search
  ) {
    throw new Error("Neon Auth URLs must not contain credentials, fragments, or query parameters.");
  }

  const expectedJwksUrl = `${authUrl.href.replace(/\/+$/, "")}/.well-known/jwks.json`;
  if (jwksUrl.href !== expectedJwksUrl) {
    throw new Error("Neon Auth JWKS URL does not match the configured Auth base URL.");
  }

  if (env.INTEGRATION_MODE === "true") {
    if (authUrl.hostname === PRODUCTION_AUTH_HOST) {
      throw new Error("Integration environment references the production Auth endpoint.");
    }
    if (
      authUrl.href !== APPROVED_INTEGRATION_TARGET.authBaseUrl ||
      jwksUrl.href !== APPROVED_INTEGRATION_TARGET.authJwksUrl
    ) {
      throw new Error("Neon Auth URLs do not match the approved test Auth endpoint.");
    }
  }

  return {
    issuer: authUrl.origin,
    jwksUrl: jwksUrl.href
  };
}

function parseDatabaseConnection(connectionString) {
  if (
    typeof connectionString !== "string" ||
    RAW_CONTROL_OR_WHITESPACE.test(connectionString)
  ) {
    throw new Error("Invalid DATABASE_URL_POOLED in integration environment.");
  }

  let databaseUrl;

  try {
    databaseUrl = new URL(connectionString);
  } catch {
    throw new Error("Invalid DATABASE_URL_POOLED in integration environment.");
  }

  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
    throw new Error("DATABASE_URL_POOLED must be a PostgreSQL URL.");
  }

  if (
    !databaseUrl.hostname ||
    databaseUrl.hash ||
    connectionString.includes("#") ||
    /%(?![0-9a-fA-F]{2})/.test(connectionString)
  ) {
    throw new Error("Invalid DATABASE_URL_POOLED in integration environment.");
  }

  const seenParameters = new Set();
  for (const [name] of databaseUrl.searchParams) {
    if (seenParameters.has(name)) {
      throw new Error("DATABASE_URL_POOLED contains ambiguous duplicate parameters.");
    }
    seenParameters.add(name);

    if (FORBIDDEN_DATABASE_QUERY_PARAMETERS.has(name) && name !== "sslmode") {
      throw new Error("DATABASE_URL_POOLED contains a forbidden query parameter.");
    }
    if (!ALLOWED_DATABASE_QUERY_PARAMETERS.has(name)) {
      throw new Error("DATABASE_URL_POOLED contains an unsupported query parameter.");
    }
  }

  if (
    databaseUrl.searchParams.has("sslmode") &&
    databaseUrl.searchParams.get("sslmode") !== "verify-full"
  ) {
    throw new Error("DATABASE_URL_POOLED must use sslmode=verify-full when SSL mode is specified.");
  }
  if (
    databaseUrl.searchParams.has("channel_binding") &&
    databaseUrl.searchParams.get("channel_binding") !== "require"
  ) {
    throw new Error("DATABASE_URL_POOLED contains an unsupported channel_binding value.");
  }

  let parsed;
  try {
    parsed = parse(connectionString);
  } catch {
    throw new Error("Invalid DATABASE_URL_POOLED in integration environment.");
  }

  return { databaseUrl, parsed };
}

function validateDatabaseDestination(env) {
  const { databaseUrl, parsed } = parseDatabaseConnection(env.DATABASE_URL_POOLED);
  const port = String(parsed.port || APPROVED_INTEGRATION_TARGET.databasePort);
  let urlUser;

  try {
    urlUser = decodeURIComponent(databaseUrl.username);
  } catch {
    throw new Error("Invalid DATABASE_URL_POOLED user in integration environment.");
  }

  if (
    databaseUrl.hostname !== APPROVED_INTEGRATION_TARGET.databaseHost ||
    parsed.host !== APPROVED_INTEGRATION_TARGET.databaseHost
  ) {
    throw new Error("DATABASE_URL_POOLED does not match the approved test endpoint.");
  }
  if (env.TEST_NEON_DB_HOST !== APPROVED_INTEGRATION_TARGET.databaseHost) {
    throw new Error("TEST_NEON_DB_HOST does not match the approved test endpoint.");
  }
  if (port !== APPROVED_INTEGRATION_TARGET.databasePort) {
    throw new Error("DATABASE_URL_POOLED does not use the approved test database port.");
  }
  if (parsed.database !== APPROVED_INTEGRATION_TARGET.databaseName) {
    throw new Error("DATABASE_URL_POOLED does not use the approved test database.");
  }
  if (!urlUser || parsed.user !== urlUser) {
    throw new Error("DATABASE_URL_POOLED contains an invalid or conflicting user.");
  }
  if (!parsed.password) {
    throw new Error("DATABASE_URL_POOLED must include test database credentials.");
  }
  if (parsed.ssl === false || parsed.ssl?.rejectUnauthorized === false) {
    throw new Error("DATABASE_URL_POOLED must use verified SSL.");
  }

  return {
    host: parsed.host,
    port,
    database: parsed.database,
    user: parsed.user,
    password: parsed.password,
    ssl: { rejectUnauthorized: true },
    sslnegotiation: "postgres",
    options: " "
  };
}

export function getIntegrationDatabaseConfig(env = process.env, { direct = false } = {}) {
  if (env.INTEGRATION_MODE !== "true") {
    throw new Error("Approved isolated integration mode is required.");
  }

  for (const name of REQUIRED_VARIABLES) {
    if (!env[name]) {
      throw new Error(`Missing ${name} in integration environment.`);
    }
  }

  if (env.PGOPTIONS) {
    throw new Error("PGOPTIONS is not allowed in integration mode.");
  }

  if (
    env.TEST_NEON_PROJECT_ID === PRODUCTION_PROJECT_ID ||
    env.TEST_NEON_BRANCH_ID === PRODUCTION_BRANCH_ID
  ) {
    throw new Error("Integration environment references the production Neon project.");
  }
  if (
    env.TEST_NEON_PROJECT_ID !== APPROVED_INTEGRATION_TARGET.projectId ||
    env.TEST_NEON_BRANCH_ID !== APPROVED_INTEGRATION_TARGET.branchId
  ) {
    throw new Error("Integration environment does not reference the approved Neon test project.");
  }

  const databaseConfig = validateDatabaseDestination(env);
  if (direct) {
    databaseConfig.host = APPROVED_INTEGRATION_TARGET.directDatabaseHost;
  }

  getAuthVerificationConfig(env);
  if (env.TEST_NEON_AUTH_HOST !== APPROVED_INTEGRATION_TARGET.authHost) {
    throw new Error("TEST_NEON_AUTH_HOST does not match the approved test Auth endpoint.");
  }
  if (env.TEST_NEON_AUTH_URL !== env.NEON_AUTH_BASE_URL) {
    throw new Error("TEST_NEON_AUTH_URL must match NEON_AUTH_BASE_URL.");
  }

  const authOrigin = parseUrl(env.TEST_AUTH_ORIGIN, "TEST_AUTH_ORIGIN");
  if (
    authOrigin.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(authOrigin.hostname)
  ) {
    throw new Error("TEST_AUTH_ORIGIN must be a local HTTP origin.");
  }

  const apiUrl = parseUrl(env.TEST_API_URL, "TEST_API_URL");
  if (apiUrl.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(apiUrl.hostname)) {
    throw new Error("TEST_API_URL must use a local HTTP endpoint for integration testing.");
  }

  const cookiePath = env.TEST_COOKIE_FILE.replace(/\\/g, "/");
  if (
    cookiePath === "cookies.txt" ||
    cookiePath.endsWith("/cookies.txt") ||
    !cookiePath.includes("integration")
  ) {
    throw new Error("TEST_COOKIE_FILE must use the isolated integration cookie jar.");
  }

  return databaseConfig;
}

export function validateIntegrationEnvironment(env = process.env) {
  if (env.INTEGRATION_MODE !== "true") {
    return;
  }

  getIntegrationDatabaseConfig(env);
}
