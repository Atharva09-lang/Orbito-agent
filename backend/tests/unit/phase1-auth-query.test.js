import assert from "node:assert/strict";
import { test } from "node:test";

import { readAuthUserVerificationRows } from "../phase1-auth.helpers.js";

test("Auth verification query uses actual quoted camelCase columns", async () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const rows = [{
    id: userId,
    name: "Synthetic User",
    email: "synthetic@example.com",
    emailVerified: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z")
  }];
  let captured;

  const result = await readAuthUserVerificationRows({
    async query(text, params) {
      captured = { text, params };
      return { rows };
    }
  }, [userId]);

  const normalized = captured.text.replace(/\s+/g, " ").trim();
  assert.match(normalized, /"emailVerified"/);
  assert.match(normalized, /"createdAt"/);
  assert.match(normalized, /"updatedAt"/);
  assert.match(normalized, /ORDER BY "createdAt", id/);
  assert.doesNotMatch(normalized, /\bcreated_at\b/);
  assert.deepEqual(captured.params, [[userId]]);
  assert.equal(result, rows);
});
