import { spawnSync } from "node:child_process";
import path from "node:path";

import { validateIntegrationEnvironment } from "../src/config/integration-env.js";
import { BACKEND_DIR, HTTP_INTEGRATION_FILES } from "./unit/suite-files.js";

if (process.env.INTEGRATION_MODE !== "true") {
  throw new Error("Approved isolated integration mode is required.");
}
validateIntegrationEnvironment();

for (const file of HTTP_INTEGRATION_FILES) {
  const result = spawnSync(process.execPath, [path.join(BACKEND_DIR, file)], {
    cwd: BACKEND_DIR,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
