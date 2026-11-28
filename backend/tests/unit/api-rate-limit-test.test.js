import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RATE_LIMIT_SCRIPT = path.join(BACKEND_DIR, "tests/api-rate-limit.integration.js");
const RATE_LIMIT_BODY = {
  success: false,
  message: "Too many requests. Please try again later."
};

function runRateLimit(port) {
  const child = spawn(process.execPath, [RATE_LIMIT_SCRIPT], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      TEST_API_URL: `http://127.0.0.1:${port}/api`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function startServer(t, handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
  return server.address().port;
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

test("the rate-limit integration script passes only after observing the HTTP 429 contract", async (t) => {
  let requests = 0;
  const port = await startServer(t, (request, response) => {
    requests += 1;
    if (requests <= 100) {
      json(response, 200, { success: true });
    } else {
      json(response, 429, RATE_LIMIT_BODY);
    }
  });

  const result = await runRateLimit(port);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(requests, 101);
  assert.match(result.stdout, /Request 101: HTTP 429/);
  assert.match(result.stdout, /'429': 1/);
});

test("the rate-limit integration script fails when no HTTP 429 is observed", async (t) => {
  let requests = 0;
  const port = await startServer(t, (request, response) => {
    requests += 1;
    json(response, 200, { success: true });
  });

  const result = await runRateLimit(port);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(requests, 101);
  assert.match(result.stderr, /Expected at least one HTTP 429 response/);
});

test("the rate-limit integration script fails when the HTTP 429 body contract is wrong", async (t) => {
  let requests = 0;
  const port = await startServer(t, (request, response) => {
    requests += 1;
    if (requests <= 100) {
      json(response, 200, { success: true });
    } else {
      json(response, 429, { success: true, message: "wrong contract" });
    }
  });

  const result = await runRateLimit(port);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(requests, 101);
  assert.match(result.stderr, /Rate limit test failed/);
});

test("the rate-limit integration script exits nonzero when the API request fails", async () => {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });

  const result = await runRateLimit(port);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /Rate limit test failed/);
});
