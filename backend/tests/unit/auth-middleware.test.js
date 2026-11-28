import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  exportJWK,
  generateKeyPair,
  SignJWT
} from "jose";

import { APPROVED_INTEGRATION_TARGET } from "../../src/config/integration-env.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ISSUER = new URL(APPROVED_INTEGRATION_TARGET.authBaseUrl).origin;
const AUTH_ENV = {
  INTEGRATION_MODE: "true",
  NEON_AUTH_BASE_URL: APPROVED_INTEGRATION_TARGET.authBaseUrl,
  NEON_AUTH_JWKS_URL: APPROVED_INTEGRATION_TARGET.authJwksUrl
};

function replaceEnvironment(t, values) {
  const previous = new Map();
  for (const [name, value] of Object.entries({ ...AUTH_ENV, ...values })) {
    previous.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
}

async function importMiddleware() {
  return import(`../../src/middleware/auth.middleware.js?unit=${randomUUID()}`);
}

function mockResponse() {
  return {
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
}

test("valid authentication lazily initializes JWKS and preserves issuer, audience, and subject checks", async (t) => {
  replaceEnvironment(t, {});
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = {
    ...await exportJWK(publicKey),
    kid: "unit-key",
    alg: "RS256",
    use: "sig"
  };
  let fetchAttempts = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    fetchAttempts += 1;
    const url = typeof input === "string" ? input : input.url;
    assert.equal(url, APPROVED_INTEGRATION_TARGET.authJwksUrl);
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });
  t.mock.method(console, "error", () => {});

  const { verifyToken } = await importMiddleware();
  assert.equal(fetchAttempts, 0);

  const token = await new SignJWT({ sub: USER_ID })
    .setProtectedHeader({ alg: "RS256", kid: "unit-key", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = mockResponse();
  let nextCalls = 0;
  await verifyToken(req, res, () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 1);
  assert.deepEqual(req.user, { id: USER_ID });
  assert.equal(fetchAttempts, 1);

  const wrongAudienceToken = await new SignJWT({ sub: USER_ID })
    .setProtectedHeader({ alg: "RS256", kid: "unit-key", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience("https://wrong-audience.invalid")
    .setExpirationTime("5m")
    .sign(privateKey);
  const wrongAudienceResponse = mockResponse();
  let wrongAudienceNextCalls = 0;
  await verifyToken(
    { headers: { authorization: `Bearer ${wrongAudienceToken}` } },
    wrongAudienceResponse,
    () => {
      wrongAudienceNextCalls += 1;
    }
  );

  assert.equal(wrongAudienceResponse.statusCode, 401);
  assert.equal(wrongAudienceNextCalls, 0);

  const wrongIssuerToken = await new SignJWT({ sub: USER_ID })
    .setProtectedHeader({ alg: "RS256", kid: "unit-key", typ: "JWT" })
    .setIssuer("https://wrong-issuer.invalid")
    .setAudience(ISSUER)
    .setExpirationTime("5m")
    .sign(privateKey);
  const wrongIssuerResponse = mockResponse();
  let wrongIssuerNextCalls = 0;
  await verifyToken(
    { headers: { authorization: `Bearer ${wrongIssuerToken}` } },
    wrongIssuerResponse,
    () => {
      wrongIssuerNextCalls += 1;
    }
  );

  assert.equal(wrongIssuerResponse.statusCode, 401);
  assert.equal(wrongIssuerNextCalls, 0);

  const tamperedParts = token.split(".");
  tamperedParts[2] = `${tamperedParts[2][0] === "A" ? "B" : "A"}${tamperedParts[2].slice(1)}`;
  const tamperedSignatureResponse = mockResponse();
  let tamperedSignatureNextCalls = 0;
  await verifyToken(
    { headers: { authorization: `Bearer ${tamperedParts.join(".")}` } },
    tamperedSignatureResponse,
    () => {
      tamperedSignatureNextCalls += 1;
    }
  );

  assert.equal(tamperedSignatureResponse.statusCode, 401);
  assert.equal(tamperedSignatureNextCalls, 0);
  assert.equal(fetchAttempts, 1);

  const missingSubjectToken = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "unit-key", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setExpirationTime("5m")
    .sign(privateKey);
  const missingSubjectResponse = mockResponse();
  let missingSubjectNextCalls = 0;
  await verifyToken(
    { headers: { authorization: `Bearer ${missingSubjectToken}` } },
    missingSubjectResponse,
    () => {
      missingSubjectNextCalls += 1;
    }
  );

  assert.equal(missingSubjectResponse.statusCode, 401);
  assert.equal(missingSubjectNextCalls, 0);
});

test("an unapproved Auth tenant is rejected before JWKS initialization or fetch", async (t) => {
  const wrongBaseUrl = "https://ep-other.neonauth.example/neondb/auth";
  replaceEnvironment(t, {
    NEON_AUTH_BASE_URL: wrongBaseUrl,
    NEON_AUTH_JWKS_URL: `${wrongBaseUrl}/.well-known/jwks.json`
  });
  let fetchAttempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchAttempts += 1;
    throw new Error("Unexpected fetch.");
  });

  await assert.rejects(importMiddleware(), /approved test Auth endpoint/);
  assert.equal(fetchAttempts, 0);
});
