import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { writeSync } from "node:fs";

const GUARD_URL = new URL("./no-external-network.js", import.meta.url).href;
const GUARD_MARKER = Symbol.for("orbito.unit.no-external-network");
const APPROVED_LOOPBACK = new Set(["127.0.0.1", "::1"]);

if (!globalThis[GUARD_MARKER]) {
  Object.defineProperty(globalThis, GUARD_MARKER, { value: true });

  const attempts = [];
  const originalFetch = globalThis.fetch;
  const originalLookup = dns.lookup;
  const originalPromisesLookup = dns.promises.lookup;
  const originalConnect = net.Socket.prototype.connect;
  const originalUdpConnect = dgram.Socket.prototype.connect;
  const originalUdpSend = dgram.Socket.prototype.send;
  const originalExit = process.exit;
  const originalReallyExit = process.reallyExit;
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  const originalExec = childProcess.exec;
  const originalExecSync = childProcess.execSync;
  const originalExecFile = childProcess.execFile;
  const originalExecFileSync = childProcess.execFileSync;
  const originalFork = childProcess.fork;

  function normalizeAddress(value) {
    const text = String(value ?? "").trim().replace(/^\[|\]$/g, "");
    if (text.includes(":")) {
      try {
        const url = new URL(`http://[${text}]/`);
        return url.hostname.slice(1, -1).toLowerCase();
      } catch {
        return text.toLowerCase();
      }
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(text)) {
      const parts = text.split(".").map(Number);
      if (parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
        return parts.join(".");
      }
    }
    return text.toLowerCase();
  }

  function isApprovedAddress(value) {
    return APPROVED_LOOPBACK.has(normalizeAddress(value));
  }

  function isIpLiteral(value) {
    return net.isIP(String(value ?? "").trim().replace(/^\[|\]$/g, "")) !== 0;
  }

  function sanitizedTarget(kind, value) {
    if (kind === "fetch") {
      try {
        const url = value instanceof URL ? value : new URL(String(value));
        return `${url.protocol}//${url.host}`;
      } catch {
        return "invalid URL";
      }
    }

    const text = String(value ?? "unknown").replace(/[\u0000-\u001f\u007f]/g, "");
    const address = normalizeAddress(text);
    if (APPROVED_LOOPBACK.has(address) || isIpLiteral(address) || /^\d+\.\d+\.\d+\.\d+$/.test(address)) {
      return address;
    }
    try {
      return new URL(`http://${text}`).hostname;
    } catch {
      return "redacted destination";
    }
  }

  function reportAttempts() {
    const lines = [
      `EXTERNAL_NETWORK_ATTEMPT count=${attempts.length}`,
      ...attempts
    ];
    writeSync(2, `${lines.join("\n")}\n`);
  }

  function blockAttempt(kind, target) {
    const destination = sanitizedTarget(kind, target);
    attempts.push(`${kind}: ${destination}`);
    const error = new Error(`EXTERNAL_NETWORK_ATTEMPT ${kind}: ${destination}`);
    error.code = "EXTERNAL_NETWORK_ATTEMPT";
    error.stack = `Error: ${error.message}`;
    process.exitCode = 1;
    throw error;
  }

  function localLookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const addresses = [
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 }
    ];
    queueMicrotask(() => {
      if (options?.all) {
        callback(null, addresses);
        return;
      }
      const selected = options?.family === 6
        ? addresses[1]
        : addresses[0];
      callback(null, selected.address, selected.family);
    });
  }

  function validateLookupAddresses(addresses, requestedHost) {
    const entries = Array.isArray(addresses) ? addresses : [addresses];
    if (entries.length === 0) {
      blockAttempt("dns", requestedHost);
    }
    for (const entry of entries) {
      const address = typeof entry === "string" ? entry : entry?.address;
      if (!isApprovedAddress(address)) {
        blockAttempt("dns", requestedHost);
      }
    }
  }

  function guardedCustomLookup(lookup, requestedHost) {
    return function guardedLookup(hostname, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      const resolved = (error, addresses, family) => {
        if (!error) {
          validateLookupAddresses(addresses, requestedHost);
        }
        callback(error, addresses, family);
      };
      if (lookup.length < 3) {
        return lookup.call(this, hostname, resolved);
      }
      return lookup.call(this, hostname, options, resolved);
    };
  }

  function prepareTcpOptions(options) {
    if (options.path !== undefined) {
      return options;
    }
    const requestedHost = options.host || "localhost";
    const address = normalizeAddress(requestedHost);
    if (isApprovedAddress(address)) {
      const guardedOptions = { ...options, host: address };
      delete guardedOptions.lookup;
      return guardedOptions;
    }
    if (address === "localhost") {
      const lookup = options.lookup ?? localLookup;
      return {
        ...options,
        host: "localhost",
        lookup: typeof lookup === "function"
          ? guardedCustomLookup(lookup, requestedHost)
          : localLookup
      };
    }
    return blockAttempt("tcp", requestedHost);
  }

  globalThis.fetch = async (input, init) => {
    const value = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    let url;
    try {
      url = new URL(value);
    } catch {
      return originalFetch(input, init);
    }
    if (
      url.protocol !== "http:" ||
      (!isApprovedAddress(url.hostname) && normalizeAddress(url.hostname) !== "localhost")
    ) {
      return blockAttempt("fetch", url);
    }
    return originalFetch(input, init);
  };

  dns.lookup = function guardedLookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const address = normalizeAddress(hostname);
    if (isIpLiteral(hostname)) {
      return originalLookup.call(this, hostname, options, callback);
    }
    if (address === "localhost") {
      return localLookup(hostname, options, callback);
    }
    if (!isApprovedAddress(address)) {
      return blockAttempt("dns", hostname);
    }
    return originalLookup.call(this, hostname, options, callback);
  };

  dns.promises.lookup = async function guardedPromisesLookup(hostname, options) {
    const address = normalizeAddress(hostname);
    if (isIpLiteral(hostname)) {
      return originalPromisesLookup.call(this, hostname, options);
    }
    if (address === "localhost") {
      return new Promise((resolve, reject) => {
        localLookup(hostname, options, (error, resolvedAddress, family) => {
          if (error) {
            reject(error);
          } else if (options?.all) {
            resolve(resolvedAddress);
          } else {
            resolve({ address: resolvedAddress, family });
          }
        });
      });
    }
    if (!isApprovedAddress(address)) {
      return blockAttempt("dns", hostname);
    }
    return originalPromisesLookup.call(this, hostname, options);
  };

  net.Socket.prototype.connect = function guardedConnect(...args) {
    if (Array.isArray(args[0])) {
      const options = args[0][0];
      if (options && typeof options === "object") {
        args[0][0] = prepareTcpOptions(options);
        return originalConnect.apply(this, args);
      }
    }

    const first = args[0];
    if (first && typeof first === "object") {
      args[0] = prepareTcpOptions(first);
      return originalConnect.apply(this, args);
    }
    if (typeof first === "number") {
      const options = prepareTcpOptions({ port: first, host: args[1] || "localhost" });
      const callback = typeof args.at(-1) === "function" ? args.at(-1) : undefined;
      return originalConnect.call(this, options, callback);
    }
    return originalConnect.apply(this, args);
  };

  function udpLoopbackAddress(socket) {
    try {
      return socket.type() === "udp6" ? "::1" : "127.0.0.1";
    } catch {
      return "127.0.0.1";
    }
  }

  function prepareUdpDestination(socket, destination) {
    if (!destination || normalizeAddress(destination) === "localhost") {
      return udpLoopbackAddress(socket);
    }
    const address = normalizeAddress(destination);
    if (isApprovedAddress(address)) {
      return address;
    }
    return blockAttempt("udp", destination);
  }

  dgram.Socket.prototype.connect = function guardedUdpConnect(...args) {
    const destination = typeof args[1] === "string" ? args[1] : undefined;
    const address = prepareUdpDestination(this, destination);
    if (typeof args[1] === "function") {
      args.splice(1, 0, address);
    } else {
      args[1] = address;
    }
    return originalUdpConnect.apply(this, args);
  };

  function setUdpDestination(args, address) {
    if (typeof args[4] === "string" || args[4] === null) {
      args[4] = address;
      return;
    }
    if (typeof args[4] === "function") {
      const callback = args[4];
      args[4] = address;
      args[5] = callback;
      return;
    }
    if (typeof args[2] === "string" || args[2] === null) {
      args[2] = address;
      return;
    }
    if (typeof args[2] === "function") {
      args.splice(2, 0, address);
      return;
    }
    if (args.length >= 4) {
      args[4] = address;
      return;
    }
    args[2] = address;
  }

  dgram.Socket.prototype.send = function guardedUdpSend(...args) {
    let remote;
    try {
      remote = this.remoteAddress?.();
    } catch {}
    if (remote?.address) {
      if (!isApprovedAddress(remote.address)) {
        return blockAttempt("udp", remote.address);
      }
      return originalUdpSend.apply(this, args);
    }

    const destination = typeof args[4] === "string"
      ? args[4]
      : typeof args[2] === "string"
        ? args[2]
        : undefined;
    setUdpDestination(args, prepareUdpDestination(this, destination));
    return originalUdpSend.apply(this, args);
  };

  function withGuardNodeOptions(existing) {
    const options = String(existing ?? "").split(/\s+/).filter(Boolean);
    return [
      `--import=${GUARD_URL}`,
      ...options.filter((option) => option !== `--import=${GUARD_URL}`)
    ].join(" ");
  }

  function guardedChildOptions(options = {}) {
    return {
      ...options,
      env: {
        ...(options.env ?? process.env),
        NODE_OPTIONS: withGuardNodeOptions(options.env?.NODE_OPTIONS ?? process.env.NODE_OPTIONS)
      }
    };
  }

  function guardedNodeArgs(args) {
    return [`--import=${GUARD_URL}`, ...args];
  }

  function assertNodeCommand(command, options) {
    if (options?.shell) {
      return blockAttempt("child_process", "shell execution");
    }
    const value = String(command);
    const approved = process.platform === "win32"
      ? value.toLowerCase() === process.execPath.toLowerCase()
      : value === process.execPath;
    if (!approved) {
      return blockAttempt("child_process", "unapproved executable");
    }
  }

  childProcess.spawn = function guardedSpawn(command, args = [], options = {}) {
    if (!Array.isArray(args)) {
      options = args;
      args = [];
    }
    assertNodeCommand(command, options);
    return originalSpawn.call(this, command, guardedNodeArgs(args), guardedChildOptions(options));
  };

  childProcess.spawnSync = function guardedSpawnSync(command, args = [], options = {}) {
    if (!Array.isArray(args)) {
      options = args;
      args = [];
    }
    assertNodeCommand(command, options);
    return originalSpawnSync.call(this, command, guardedNodeArgs(args), guardedChildOptions(options));
  };

  childProcess.exec = function blockedExec() {
    return blockAttempt("child_process", "shell execution");
  };

  childProcess.execSync = function blockedExecSync() {
    return blockAttempt("child_process", "shell execution");
  };

  childProcess.execFile = function guardedExecFile(file, args = [], options, callback) {
    if (!Array.isArray(args)) {
      callback = typeof options === "function" ? options : callback;
      options = args;
      args = [];
    } else if (typeof options === "function") {
      callback = options;
      options = {};
    }
    assertNodeCommand(file, options);
    return originalExecFile.call(
      this,
      file,
      guardedNodeArgs(args),
      guardedChildOptions(options ?? {}),
      callback
    );
  };

  childProcess.execFileSync = function guardedExecFileSync(file, args = [], options) {
    if (!Array.isArray(args)) {
      options = args;
      args = [];
    }
    assertNodeCommand(file, options);
    return originalExecFileSync.call(
      this,
      file,
      guardedNodeArgs(args),
      guardedChildOptions(options ?? {})
    );
  };

  childProcess.fork = function guardedFork(modulePath, args = [], options = {}) {
    if (!Array.isArray(args)) {
      options = args;
      args = [];
    }
    assertNodeCommand(options.execPath ?? process.execPath, options);
    const guardedOptions = guardedChildOptions(options);
    const execArgv = Array.isArray(guardedOptions.execArgv)
      ? guardedOptions.execArgv
      : process.execArgv;
    guardedOptions.execArgv = guardedNodeArgs(
      execArgv.filter((option) => option !== `--import=${GUARD_URL}`)
    );
    return originalFork.call(this, modulePath, args, guardedOptions);
  };

  process.exit = function guardedExit(code) {
    if (attempts.length > 0) {
      reportAttempts();
      return originalReallyExit(1);
    }
    return originalExit(code);
  };

  process.reallyExit = function guardedReallyExit(code) {
    if (attempts.length > 0) {
      reportAttempts();
      return originalReallyExit(1);
    }
    return originalReallyExit(code);
  };

  const beforeExitGuard = () => {
    if (attempts.length > 0) {
      process.exitCode = 1;
    }
  };

  const exitGuard = (code) => {
    if (attempts.length > 0) {
      reportAttempts();
      return originalReallyExit(1);
    }
    if (process.env.TEST_NETWORK_GUARD_REPORT === "true") {
      writeSync(1, "EXTERNAL_NETWORK_ATTEMPTS=0\n");
    }
    return code;
  };

  const guardListeners = new Set([beforeExitGuard, exitGuard]);
  const originalRemoveListener = process.removeListener;
  const originalRemoveAllListeners = process.removeAllListeners;

  process.prependListener("beforeExit", beforeExitGuard);
  process.prependListener("exit", exitGuard);

  function guardedRemoveListener(event, listener) {
    if (guardListeners.has(listener)) {
      return process;
    }
    return originalRemoveListener.call(process, event, listener);
  }

  process.removeListener = guardedRemoveListener;
  process.off = guardedRemoveListener;
  process.removeAllListeners = function guardedRemoveAllListeners(event) {
    const events = event === undefined ? process.eventNames() : [event];
    for (const name of events) {
      for (const listener of process.listeners(name)) {
        if (!guardListeners.has(listener)) {
          originalRemoveListener.call(process, name, listener);
        }
      }
    }
    return process;
  };

  syncBuiltinESMExports();
}
