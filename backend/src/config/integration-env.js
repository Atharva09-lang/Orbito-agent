const PRODUCTION_PROJECT_ID = "winter-math-54988029";
const PRODUCTION_BRANCH_ID = "br-restless-silence-ao5ra3rh";
const PRODUCTION_AUTH_HOST = "ep-calm-violet-aophputx.neonauth.c-2.ap-southeast-1.aws.neon.tech";

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

function parseUrl(value, name) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`Invalid ${name} in integration environment.`);
  }
}

export function validateIntegrationEnvironment(env = process.env) {
  if (env.INTEGRATION_MODE !== "true") {
    return;
  }

  for (const name of REQUIRED_VARIABLES) {
    if (!env[name]) {
      throw new Error(`Missing ${name} in integration environment.`);
    }
  }

  if (
    env.TEST_NEON_PROJECT_ID === PRODUCTION_PROJECT_ID ||
    env.TEST_NEON_BRANCH_ID === PRODUCTION_BRANCH_ID
  ) {
    throw new Error("Integration environment references the production Neon project.");
  }

  const databaseUrl = parseUrl(env.DATABASE_URL_POOLED, "DATABASE_URL_POOLED");
  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
    throw new Error("DATABASE_URL_POOLED must be a PostgreSQL URL.");
  }
  if (databaseUrl.hostname !== env.TEST_NEON_DB_HOST) {
    throw new Error("DATABASE_URL_POOLED does not match the approved test endpoint.");
  }
  if (!databaseUrl.hostname.includes("pooler")) {
    throw new Error("DATABASE_URL_POOLED must use the approved pooled test endpoint.");
  }

  const authUrl = parseUrl(env.NEON_AUTH_BASE_URL, "NEON_AUTH_BASE_URL");
  const jwksUrl = parseUrl(env.NEON_AUTH_JWKS_URL, "NEON_AUTH_JWKS_URL");
  if (
    authUrl.hostname !== env.TEST_NEON_AUTH_HOST ||
    jwksUrl.hostname !== env.TEST_NEON_AUTH_HOST
  ) {
    throw new Error("Neon Auth URLs do not match the approved test Auth endpoint.");
  }
  if (authUrl.hostname === PRODUCTION_AUTH_HOST) {
    throw new Error("Integration environment references the production Auth endpoint.");
  }
  if (env.TEST_NEON_AUTH_URL !== env.NEON_AUTH_BASE_URL) {
    throw new Error("TEST_NEON_AUTH_URL must match NEON_AUTH_BASE_URL.");
  }

  const authPath = authUrl.pathname.replace(/\/+$/, "");
  if (!jwksUrl.pathname.startsWith(`${authPath}/`)) {
    throw new Error("NEON_AUTH_JWKS_URL does not belong to NEON_AUTH_BASE_URL.");
  }

  const authOrigin = parseUrl(env.TEST_AUTH_ORIGIN, "TEST_AUTH_ORIGIN");
  if (
    authOrigin.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(authOrigin.hostname)
  ) {
    throw new Error("TEST_AUTH_ORIGIN must be a local HTTP origin.");
  }

  const apiUrl = parseUrl(env.TEST_API_URL, "TEST_API_URL");
  if (apiUrl.protocol !== "http:") {
    throw new Error("TEST_API_URL must use HTTP for local integration testing.");
  }

  const cookiePath = env.TEST_COOKIE_FILE.replace(/\\/g, "/");
  if (
    cookiePath === "cookies.txt" ||
    cookiePath.endsWith("/cookies.txt") ||
    !cookiePath.includes("integration")
  ) {
    throw new Error("TEST_COOKIE_FILE must use the isolated integration cookie jar.");
  }
}
