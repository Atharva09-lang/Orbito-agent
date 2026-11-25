import { test } from "node:test";
import assert from "node:assert/strict";

import { extractKeywords } from "../../src/utils/keywords.js";

test("extractKeywords removes stop words, short words and duplicates", () => {
  assert.deepEqual(
    extractKeywords("What did we discuss about Redis and redis caching?"),
    ["redis", "caching"]
  );
});

test("extractKeywords returns an empty list when nothing meaningful remains", () => {
  assert.deepEqual(extractKeywords("what about it?"), []);
});
