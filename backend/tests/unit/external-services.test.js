import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { APPROVED_INTEGRATION_TARGET } from "../../src/config/integration-env.js";

const BACKEND_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const ISOLATED_ENV = {
  INTEGRATION_MODE: "true",
  NODE_ENV: "production",
  DATABASE_URL_POOLED: `postgresql://user:pass@${APPROVED_INTEGRATION_TARGET.databaseHost}:5432/neondb`,
  NEON_AUTH_BASE_URL: APPROVED_INTEGRATION_TARGET.authBaseUrl,
  NEON_AUTH_JWKS_URL: APPROVED_INTEGRATION_TARGET.authJwksUrl,
  TEST_API_URL: "http://localhost:5000/api",
  TEST_NEON_AUTH_URL: APPROVED_INTEGRATION_TARGET.authBaseUrl,
  TEST_AUTH_ORIGIN: "http://localhost:5173",
  TEST_COOKIE_FILE: "./cookies.integration.local",
  TEST_NEON_PROJECT_ID: APPROVED_INTEGRATION_TARGET.projectId,
  TEST_NEON_BRANCH_ID: APPROVED_INTEGRATION_TARGET.branchId,
  TEST_NEON_DB_HOST: APPROVED_INTEGRATION_TARGET.databaseHost,
  TEST_NEON_AUTH_HOST: APPROVED_INTEGRATION_TARGET.authHost
};

function runIsolated(script) {
  const env = { ...process.env, ...ISOLATED_ENV };
  delete env.GROQ_API_KEY;
  delete env.TAVILY_API_KEY;
  delete env.PGOPTIONS;
  delete env.DATABASE_URL;
  delete env.TEST_CONVERSATION_ID;
  delete env.TEST_MEMORY_ID;

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: BACKEND_DIR,
      env,
      encoding: "utf8",
      timeout: 20000
    }
  );

  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);

  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines.at(-1));
}

test("backend initializes database-backed routes without external API keys", () => {
  const result = runIsolated(`
    const { once } = await import("node:events");
    const originalFetch = globalThis.fetch;
    let externalFetchAttempts = 0;
    globalThis.fetch = async (input, init) => {
      const value = typeof input === "string" ? input : input.url;
      const url = new URL(value);
      if (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
        return originalFetch(input, init);
      }
      externalFetchAttempts += 1;
      throw new Error("Unexpected external fetch during app import.");
    };

    const { default: app } = await import("./src/app.js");
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");

    const baseUrl = \`http://127.0.0.1:\${server.address().port}\`;
    const root = await fetch(\`\${baseUrl}/\`);
    const memories = await fetch(\`\${baseUrl}/api/memories\`);

    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));

    process.stdout.write(JSON.stringify({
      rootStatus: root.status,
      memoriesStatus: memories.status,
      externalFetchAttempts
    }));
    process.exit(0);
  `);

  assert.deepEqual(result, { rootStatus: 200, memoriesStatus: 401, externalFetchAttempts: 0 });
});

test("AI requests report missing Groq configuration without network access", () => {
  const result = runIsolated(`
    const { generateResponse } = await import("./src/services/llm.service.js");

    try {
      await generateResponse([{ role: "user", content: "Hello" }]);
      process.stdout.write(JSON.stringify({ threw: false }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        threw: true,
        code: error.code,
        status: error.status,
        message: error.message
      }));
    }

    process.exit(0);
  `);

  assert.deepEqual(result, {
    threw: true,
    code: "GROQ_NOT_CONFIGURED",
    status: 503,
    message: "GROQ_API_KEY is missing from environment variables."
  });
});

test("message controller returns 503 when Groq is not configured", () => {
  const result = runIsolated(`
    const { default: pool } = await import("./src/config/database.js");
    const { createMessageController } = await import("./src/controllers/message.controller.js");

    const userId = "11111111-1111-4111-8111-111111111111";
    const conversationId = "22222222-2222-4222-8222-222222222222";
    const userMessage = {
      id: "33333333-3333-4333-8333-333333333333",
      conversation_id: conversationId,
      role: "user",
      content: "Hello",
      metadata: {},
      created_at: new Date().toISOString()
    };

    pool.connect = async () => ({
      async query(text) {
        const normalized = text.replace(/\\s+/g, " ").trim();
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
          return { rows: [] };
        }
        if (normalized.startsWith("INSERT INTO messages")) {
          return { rows: [userMessage] };
        }
        if (normalized.startsWith("UPDATE conversations")) {
          return { rows: [] };
        }
        throw new Error(\`Unexpected client query: \${text}\`);
      },
      release() {}
    });

    pool.query = async (text) => {
      const normalized = text.replace(/\\s+/g, " ").trim();
      if (normalized.startsWith("SELECT") && normalized.includes(") recent")) {
        return { rows: [userMessage] };
      }
      if (normalized.startsWith("SELECT")) {
        return { rows: [] };
      }
      if (normalized.startsWith("UPDATE messages")) {
        return { rows: [{ id: userMessage.id }] };
      }
      throw new Error(\`Unexpected pooled query: \${text}\`);
    };

    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};

    const req = {
      user: { id: userId },
      params: { conversationId },
      body: { content: "Hello" }
    };
    const res = {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      }
    };

    await createMessageController(req, res);
    process.stdout.write(JSON.stringify({ status: res.statusCode, body: res.body }));
    process.exit(0);
  `);

  assert.equal(result.status, 503, JSON.stringify(result));
  assert.deepEqual(result.body, {
    success: false,
    message: "AI service is not configured."
  });
});

test("web search reports missing Tavily configuration without retrying", () => {
  const result = runIsolated(`
    const { executeTool } = await import("./src/tools/tool.registry.js");

    try {
      await executeTool("search_web", { query: "latest news" });
      process.stdout.write(JSON.stringify({ threw: false }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        threw: true,
        code: error.code,
        status: error.status,
        message: error.message
      }));
    }

    process.exit(0);
  `);

  assert.deepEqual(result, {
    threw: true,
    code: "TAVILY_NOT_CONFIGURED",
    status: 503,
    message: "TAVILY_API_KEY is missing from environment variables."
  });
});
