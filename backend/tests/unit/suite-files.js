import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BACKEND_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

export const PHASE_INTEGRATION_FILES = [
  "tests/phase1-auth-isolation.integration.js",
  "tests/phase1-auth-preservation.integration.js",
  "tests/phase2-memory-lifecycle.integration.js",
  "tests/phase2-memory-fix-regression.integration.js",
  "tests/phase2-memory-repository.integration.js",
  "tests/phase3-memory-concurrency.integration.js"
];

export const OWNERSHIP_INTEGRATION_FILES = [
  "tests/memory-ownership.integration.js"
];

export const HTTP_INTEGRATION_FILES = [
  "tests/auth.integration.js",
  "tests/api-rate-limit.integration.js",
  "tests/body-limit.integration.js",
  "tests/conversation-lifecycle.integration.js",
  "tests/invalid-json.integration.js",
  "tests/memory-delete.integration.js",
  "tests/memory-get.integration.js",
  "tests/memory-lifecycle.integration.js",
  "tests/memory-patch.integration.js",
  "tests/memory-post.integration.js",
  "tests/message-rate-limit.integration.js",
  "tests/message.integration.js",
  "tests/validation.integration.js"
];

const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "coverage",
  "logs",
  "log"
]);

export function listDiscoverableTestFiles(directory = BACKEND_DIR, insideTestDirectory = false) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) {
        return [];
      }
      return listDiscoverableTestFiles(
        entryPath,
        insideTestDirectory || entry.name === "test"
      );
    }
    if (!entry.isFile()) {
      return [];
    }

    const defaultPattern = /(?:\.test\.|-test\.|_test\.)[cm]?js$/.test(entry.name) ||
      /^test(?:-.*)?\.[cm]?js$/.test(entry.name);
    const testDirectoryPattern = insideTestDirectory && /\.[cm]?js$/.test(entry.name);
    return defaultPattern || testDirectoryPattern ? [entryPath] : [];
  });
}

export function normalizeTestPath(file) {
  return file.replaceAll("\\", "/");
}

export function getDefaultUnitTestFiles() {
  const unitDirectory = path.join(BACKEND_DIR, "tests/unit");
  return [
    "src/config/database.test.js",
    ...readdirSync(unitDirectory)
      .filter((name) => name.endsWith(".test.js"))
      .sort()
      .map((name) => `tests/unit/${name}`)
  ];
}

export function getOptInIntegrationFiles() {
  return [
    ...PHASE_INTEGRATION_FILES,
    ...OWNERSHIP_INTEGRATION_FILES,
    ...HTTP_INTEGRATION_FILES
  ];
}

export function assertIntegrationFilesExist() {
  for (const file of getOptInIntegrationFiles()) {
    if (!existsSync(path.join(BACKEND_DIR, file))) {
      throw new Error(`Missing opt-in integration file: ${file}`);
    }
  }
}
