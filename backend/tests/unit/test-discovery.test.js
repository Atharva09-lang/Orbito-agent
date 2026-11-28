import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  assertIntegrationFilesExist,
  BACKEND_DIR,
  getDefaultUnitTestFiles,
  getOptInIntegrationFiles,
  HTTP_INTEGRATION_FILES,
  listDiscoverableTestFiles,
  normalizeTestPath
} from "./suite-files.js";

function absolute(file) {
  return path.join(BACKEND_DIR, file);
}

test("default unit inventory contains only mocked unit tests", () => {
  const files = getDefaultUnitTestFiles();

  assert.equal(files.includes("src/config/database.test.js"), true);
  for (const file of files) {
    assert.match(
      file,
      /^(?:src\/config\/database\.test\.js|tests\/unit\/[^/]+\.test\.js)$/
    );
  }

  const discovered = listDiscoverableTestFiles(BACKEND_DIR)
    .map((file) => normalizeTestPath(path.relative(BACKEND_DIR, file)))
    .sort();
  assert.deepEqual(discovered, [...files].sort());
});

test("integration and localhost HTTP suites require explicit opt-in", () => {
  assertIntegrationFilesExist();
  const discovered = new Set(
    listDiscoverableTestFiles(BACKEND_DIR)
      .map((file) => normalizeTestPath(path.relative(BACKEND_DIR, file)))
  );

  for (const file of getOptInIntegrationFiles().map(normalizeTestPath)) {
    assert.equal(discovered.has(file), false, `${file} must not be auto-discovered`);
  }
});

test("Windows-style inventory paths are normalized before discovery comparison", () => {
  const discovered = new Set(
    listDiscoverableTestFiles(BACKEND_DIR)
      .map((file) => normalizeTestPath(path.relative(BACKEND_DIR, file)))
  );
  const windowsInventory = getOptInIntegrationFiles()
    .map((file) => file.replaceAll("/", "\\"))
    .map(normalizeTestPath);

  assert.equal(
    normalizeTestPath("tests\\unit\\example.test.js"),
    "tests/unit/example.test.js"
  );
  for (const file of windowsInventory) {
    assert.equal(discovered.has(file), false, `${file} must not be auto-discovered`);
  }
});

test("HTTP integration scripts do not hardcode a different API destination", () => {
  for (const file of HTTP_INTEGRATION_FILES) {
    const source = readFileSync(absolute(file), "utf8");
    assert.doesNotMatch(source, /http:\/\/localhost:5000/, file);
  }
});

test("package scripts omit the unsupported combined phase command", () => {
  const packageJson = JSON.parse(readFileSync(path.join(BACKEND_DIR, "package.json"), "utf8"));

  assert.equal(packageJson.scripts["test:unit"], "node tests/unit/run-unit-tests.js");
  assert.equal(packageJson.scripts["test:integration:ownership"], "node tests/memory-ownership.integration.js");
  assert.equal(packageJson.scripts["test:integration:http"], "node tests/run-http-integration.js");
  assert.equal(packageJson.scripts["test:integration:phases"], undefined);
  assert.equal(packageJson.scripts["test:integration:phase1"], "node --test tests/phase1-auth-isolation.integration.js");
  assert.equal(packageJson.scripts["test:integration:phase2-lifecycle"], "node --test tests/phase2-memory-lifecycle.integration.js");
  assert.equal(packageJson.scripts["test:integration:phase3"], "node --test tests/phase3-memory-concurrency.integration.js");
});
