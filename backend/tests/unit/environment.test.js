import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENVIRONMENT_MODULE = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/config/environment.js")
).href;

function createEnvironmentDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "minimi-env-test-"));
  writeFileSync(path.join(directory, ".env"), "MINIMI_ENV_TEST_VALUE=from-local-file\n");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runEnvironment(directory, integrationMode) {
  const env = { ...process.env };
  delete env.MINIMI_ENV_TEST_VALUE;
  if (integrationMode) {
    env.INTEGRATION_MODE = "true";
  } else {
    delete env.INTEGRATION_MODE;
  }

  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(ENVIRONMENT_MODULE)}); console.log(process.env.MINIMI_ENV_TEST_VALUE ?? "unset");`
    ],
    { cwd: directory, env, encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("integration mode does not load the local environment file", (t) => {
  const directory = createEnvironmentDirectory(t);
  assert.equal(runEnvironment(directory, true), "unset");
});

test("non-integration mode still loads the local environment file", (t) => {
  const directory = createEnvironmentDirectory(t);
  assert.equal(runEnvironment(directory, false), "from-local-file");
});
