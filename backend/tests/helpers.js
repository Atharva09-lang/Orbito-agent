
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import "../src/config/environment.js";
import { validateIntegrationEnvironment } from "../src/config/integration-env.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const COOKIE_FILE = path.resolve(
  process.env.TEST_COOKIE_FILE || path.join(TEST_DIR, "../cookies.integration.local")
);
const AUTH_BASE_URL = process.env.TEST_NEON_AUTH_URL;
const AUTH_URL = AUTH_BASE_URL
  ? `${AUTH_BASE_URL.replace(/\/+$/, "")}/token`
  : "";
const AUTH_ORIGIN = process.env.TEST_AUTH_ORIGIN || "http://localhost:5173";

export const API_BASE_URL =
  process.env.TEST_API_URL || "http://localhost:5000/api";

export async function getAuthToken() {
  if (process.env.INTEGRATION_MODE !== "true") {
    throw new Error("Integration mode is required for authenticated tests.");
  }

  validateIntegrationEnvironment();

  if (!existsSync(COOKIE_FILE)) {
    throw new Error("Integration cookie jar not found. Login first.");
  }

  const tokenResponse = execFileSync(
    "curl.exe",
    [
      "-sS",
      AUTH_URL,
      "-H",
      `Origin: ${AUTH_ORIGIN}`,
      "-b",
      COOKIE_FILE
    ],
    { encoding: "utf8" }
  );

  const tokenData = JSON.parse(tokenResponse);

  if (!tokenData.token) {
    throw new Error("JWT unavailable. Login session may have expired.");
  }

  return tokenData.token;
}
