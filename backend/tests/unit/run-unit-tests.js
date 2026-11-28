import { spawnSync } from "node:child_process";

import { BACKEND_DIR, getDefaultUnitTestFiles } from "./suite-files.js";

const networkGuard = new URL("./no-external-network.js", import.meta.url).href;
const nodeOptions = [`--import=${networkGuard}`, process.env.NODE_OPTIONS]
  .filter(Boolean)
  .join(" ");
const result = spawnSync(
  process.execPath,
  ["--import", networkGuard, "--test", ...getDefaultUnitTestFiles()],
  {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions
    },
    stdio: "inherit"
  }
);

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
