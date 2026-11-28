import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import dgram from "node:dgram";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";

const NETWORK_GUARD = new URL("./no-external-network.js", import.meta.url).href;

function guardedArguments(script) {
  return [`--import=${NETWORK_GUARD}`, "--input-type=module", "-e", script];
}

function guardedEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.NODE_OPTIONS;
  return env;
}

function runGuarded(script, overrides = {}) {
  return spawnSync(
    process.execPath,
    guardedArguments(script),
    { env: guardedEnvironment(overrides), encoding: "utf8", timeout: 10000 }
  );
}

function runGuardedAsync(script, overrides = {}) {
  const child = spawn(
    process.execPath,
    guardedArguments(script),
    { env: guardedEnvironment(overrides), stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }
  );
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
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return completion;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function listen(server, host) {
  server.listen(0, host);
  await once(server, "listening");
  return server.address().port;
}

async function bind(socket, host) {
  socket.bind(0, host);
  await once(socket, "listening");
  return socket.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function assertBlocked(result, pattern) {
  assert.equal(result.status, 1, result.stderr || result.stdout || result.error?.message);
  assert.match(result.stderr, /EXTERNAL_NETWORK_ATTEMPT count=1/);
  assert.match(result.stderr, pattern);
}

test("the unit network guard fails even when an external fetch rejection is caught", () => {
  const result = runGuarded(`
    try {
      await fetch("https://external.invalid/resource");
    } catch {}
  `);

  assertBlocked(result, /fetch: https:\/\/external\.invalid/);
});

test("network violations remain failures after exit-code changes and explicit exit", () => {
  const result = runGuarded(`
    try {
      await fetch("https://external.invalid/resource");
    } catch {}
    process.exitCode = 0;
    process.on("exit", () => {
      process.exitCode = 0;
    });
    process.exit(0);
  `);

  assertBlocked(result, /fetch: https:\/\/external\.invalid/);
});

test("network violations remain failures after exit listeners are removed", () => {
  const result = runGuarded(`
    try {
      await fetch("https://external.invalid/resource");
    } catch {}
    process.removeAllListeners("beforeExit");
    process.removeAllListeners("exit");
    process.exitCode = 0;
  `);

  assertBlocked(result, /fetch: https:\/\/external\.invalid/);
});

test("network violations remain failures when reallyExit is called", () => {
  const result = runGuarded(`
    try {
      await fetch("https://external.invalid/resource");
    } catch {}
    process.reallyExit(0);
  `);

  assertBlocked(result, /fetch: https:\/\/external\.invalid/);
});

test("blocked URL diagnostics redact userinfo, query values, and fragments", () => {
  const result = runGuarded(`
    try {
      await fetch("https://user:password-sentinel@external.invalid/path?api_key=query-sentinel#fragment-sentinel");
    } catch (error) {
      console.log(error.message);
      console.log(error.stack);
    }
  `);

  assertBlocked(result, /fetch: https:\/\/external\.invalid/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /password-sentinel|query-sentinel|fragment-sentinel/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /api_key|user:/);
});

test("blocked destination diagnostics redact embedded credentials and query values", () => {
  const result = runGuarded(`
    import dns from "node:dns";
    try {
      dns.lookup("user:password-sentinel@external.invalid?api_key=query-sentinel&authorization=Bearer%20bearer-sentinel#fragment-sentinel", () => {});
    } catch (error) {
      console.log(error.message);
      console.log(error.stack);
    }
  `);

  assertBlocked(result, /dns: external\.invalid/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /password-sentinel|query-sentinel|bearer-sentinel|fragment-sentinel|api_key|authorization|user:/);
});

test("the unit network guard fails non-loopback TCP hostname attempts", () => {
  const result = runGuarded(`
    import net from "node:net";
    try {
      const socket = net.connect({ host: "external.invalid", port: 5432 });
      socket.destroy();
    } catch {}
  `);

  assertBlocked(result, /tcp: external\.invalid/);
});

for (const host of ["192.0.2.1", "2001:db8::1"]) {
  test(`the unit network guard fails non-loopback TCP literal ${host}`, () => {
    const result = runGuarded(`
      import net from "node:net";
      try {
        const socket = net.connect({ host: ${JSON.stringify(host)}, port: 5432 });
        socket.destroy();
      } catch {}
    `);

    assertBlocked(result, new RegExp(`tcp: ${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });
}

for (const scenario of [
  {
    name: "single-address",
    autoSelectFamily: false,
    lookup: 'callback(null, "127.0.0.2", 4);'
  },
  {
    name: "multiple-address",
    autoSelectFamily: true,
    lookup: 'if (options.all) { callback(null, [{ address: "127.0.0.2", family: 4 }]); } else { callback(null, "127.0.0.2", 4); }'
  },
  {
    name: "mixed-address",
    autoSelectFamily: true,
    lookup: 'if (options.all) { callback(null, [{ address: "127.0.0.1", family: 4 }, { address: "127.0.0.2", family: 4 }]); } else { callback(null, "127.0.0.2", 4); }'
  }
]) {
  test(`custom DNS ${scenario.name} results cannot reach a disallowed loopback stand-in`, async (t) => {
    const server = net.createServer((socket) => {
      socket.destroy();
    });
    const received = [];
    server.on("connection", () => received.push(true));
    const port = await listen(server, "127.0.0.2");
    t.after(async () => {
      await close(server);
    });

    const result = await runGuardedAsync(`
      import net from "node:net";
      try {
        const socket = net.connect({
          host: "localhost",
          port: ${port},
          autoSelectFamily: ${scenario.autoSelectFamily},
          lookup(hostname, options, callback) {
            ${scenario.lookup}
          }
        });
        socket.on("error", () => {});
        socket.destroy();
      } catch {}
    `);
    await delay(150);

    assertBlocked(result, /dns: localhost/);
    assert.deepEqual(received, []);
  });
}

test("approved IPv4 and canonical IPv6 loopback TCP connections are delivered", () => {
  const result = runGuarded(`
    import net from "node:net";

    async function roundTrip(host) {
      const server = net.createServer((socket) => socket.end("received"));
      await new Promise((resolve) => server.listen(0, host, resolve));
      const response = await new Promise((resolve, reject) => {
        const client = net.connect({ host, port: server.address().port }, () => client.write("request"));
        let data = "";
        client.setEncoding("utf8");
        client.on("data", (chunk) => {
          data += chunk;
        });
        client.on("end", () => resolve(data));
        client.on("error", reject);
      });
      server.close();
      return response;
    }

    console.log("TCP4=" + await roundTrip("127.0.0.1"));
    console.log("TCP6=" + await roundTrip("0:0:0:0:0:0:0:1"));
  `, { TEST_NETWORK_GUARD_REPORT: "true" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /TCP4=received/);
  assert.match(result.stdout, /TCP6=received/);
  assert.match(result.stdout, /EXTERNAL_NETWORK_ATTEMPTS=0/);
});

test("approved localhost HTTP requests are delivered without trusting hostname resolution", () => {
  const result = runGuarded(`
    import http from "node:http";
    const server = http.createServer((request, response) => response.end("received"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const response = await fetch(\`http://localhost:\${server.address().port}/\`);
    console.log("HTTP=" + response.status + ":" + await response.text());
    await new Promise((resolve) => server.close(resolve));
  `, { TEST_NETWORK_GUARD_REPORT: "true" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /HTTP=200:received/);
  assert.match(result.stdout, /EXTERNAL_NETWORK_ATTEMPTS=0/);
});

test("approved IPv6 loopback HTTP requests are delivered", () => {
  const result = runGuarded(`
    import http from "node:http";
    const server = http.createServer((request, response) => response.end("received-v6"));
    await new Promise((resolve) => server.listen(0, "::1", resolve));
    const response = await fetch(\`http://[::1]:\${server.address().port}/\`);
    console.log("HTTP6=" + response.status + ":" + await response.text());
    server.close();
  `, { TEST_NETWORK_GUARD_REPORT: "true" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /HTTP6=200:received-v6/);
  assert.match(result.stdout, /EXTERNAL_NETWORK_ATTEMPTS=0/);
});

test("callback and promise DNS lookups reject external hostnames before resolution", () => {
  const result = runGuarded(`
    import dns from "node:dns";
    try {
      dns.lookup("external.invalid", () => {});
    } catch {}
    try {
      await dns.promises.lookup("external.invalid");
    } catch {}
  `);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /EXTERNAL_NETWORK_ATTEMPT count=2/);
  assert.match(result.stderr, /dns: external\.invalid/);
});

test("a disallowed UDP destination receives no packet", async (t) => {
  const receiver = dgram.createSocket("udp4");
  const messages = [];
  receiver.on("message", (message) => messages.push(message.toString()));
  const port = await bind(receiver, "127.0.0.2");
  t.after(async () => {
    await close(receiver);
  });

  const result = await runGuardedAsync(`
    import dgram from "node:dgram";
    const socket = dgram.createSocket("udp4");
    try {
      socket.send("must-not-arrive", ${port}, "127.0.0.2");
    } catch {}
    socket.close();
  `);
  await delay(200);

  assertBlocked(result, /udp: 127\.0\.0\.2/);
  assert.deepEqual(messages, []);
});

test("a connected UDP socket cannot send to a disallowed destination", async (t) => {
  const receiver = dgram.createSocket("udp4");
  const messages = [];
  receiver.on("message", (message) => messages.push(message.toString()));
  const port = await bind(receiver, "127.0.0.2");
  t.after(async () => {
    await close(receiver);
  });

  const result = await runGuardedAsync(`
    import dgram from "node:dgram";
    const socket = dgram.createSocket("udp4");
    try {
      socket.connect(${port}, "127.0.0.2", () => socket.send("must-not-arrive"));
    } catch {}
    setTimeout(() => socket.close(), 50);
  `);
  await delay(200);

  assertBlocked(result, /udp: 127\.0\.0\.2/);
  assert.deepEqual(messages, []);
});

test("an approved loopback UDP packet is delivered", async (t) => {
  const receiver = dgram.createSocket("udp4");
  const messages = [];
  receiver.on("message", (message) => messages.push(message.toString()));
  const port = await bind(receiver, "127.0.0.1");
  t.after(async () => {
    await close(receiver);
  });

  const result = await runGuardedAsync(`
    import dgram from "node:dgram";
    const socket = dgram.createSocket("udp4");
    socket.send("received", ${port}, "127.0.0.1", () => socket.close());
  `);
  await delay(200);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(messages, ["received"]);
});

test("an approved IPv6 loopback UDP packet is delivered", async (t) => {
  const receiver = dgram.createSocket("udp6");
  const messages = [];
  receiver.on("message", (message) => messages.push(message.toString()));
  const port = await bind(receiver, "::1");
  t.after(async () => {
    await close(receiver);
  });

  const result = await runGuardedAsync(`
    import dgram from "node:dgram";
    const socket = dgram.createSocket("udp6");
    socket.send("received-v6", ${port}, "::1", () => socket.close());
  `);
  await delay(200);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(messages, ["received-v6"]);
});

test("Node child processes inherit the guard even when NODE_OPTIONS is cleared", () => {
  const result = runGuarded(`
    import { spawnSync } from "node:child_process";
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      "try { await fetch(\\"https://external.invalid/child\\"); } catch {}"
    ], {
      env: { ...process.env, NODE_OPTIONS: "" },
      encoding: "utf8"
    });
    process.stderr.write(child.stderr);
    process.exit(child.status ?? 1);
  `);

  assertBlocked(result, /fetch: https:\/\/external\.invalid/);
});

test("shell and native child execution is blocked before the command runs", () => {
  const command = process.platform === "win32"
    ? JSON.stringify(process.env.ComSpec || "cmd.exe")
    : JSON.stringify("/bin/sh");
  const argument = process.platform === "win32" ? '"/c", "echo CHILD_EXECUTED"' : '"-c", "echo CHILD_EXECUTED"';
  const result = runGuarded(`
    import { spawnSync } from "node:child_process";
    try {
      const child = spawnSync(${command}, [${argument}], { encoding: "utf8" });
      process.stdout.write(child.stdout);
    } catch {}
  `);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /EXTERNAL_NETWORK_ATTEMPT count=1/);
  assert.match(result.stderr, /child_process:/);
  assert.doesNotMatch(result.stdout, /CHILD_EXECUTED/);
});

test("Node-named executables outside the current runtime are blocked", () => {
  const command = JSON.stringify(path.join(process.env.TEMP || process.env.TMPDIR || ".", "node"));
  const result = runGuarded(`
    import { spawnSync } from "node:child_process";
    try {
      spawnSync(${command}, ["--version"], { encoding: "utf8" });
    } catch {}
  `);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /EXTERNAL_NETWORK_ATTEMPT count=1/);
  assert.match(result.stderr, /child_process:/);
});

test("fork cannot select an unapproved executable", () => {
  const command = process.platform === "win32"
    ? JSON.stringify(process.env.ComSpec || "cmd.exe")
    : JSON.stringify("/bin/sh");
  const result = runGuarded(`
    import { fork } from "node:child_process";
    try {
      fork("./unused.js", [], { execPath: ${command} });
    } catch {}
  `);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /EXTERNAL_NETWORK_ATTEMPT count=1/);
  assert.match(result.stderr, /child_process:/);
});

test("the unit network guard reports zero attempts for a network-free process", () => {
  const result = runGuarded("await Promise.resolve();", {
    TEST_NETWORK_GUARD_REPORT: "true"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /EXTERNAL_NETWORK_ATTEMPTS=0/);
});
