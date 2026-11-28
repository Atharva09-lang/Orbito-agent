import assert from "node:assert/strict";

const API_BASE_URL = process.env.TEST_API_URL?.replace(/\/+$/, "");
if (!API_BASE_URL) {
  throw new Error("TEST_API_URL is required for HTTP integration tests.");
}

async function testApiRateLimit() {
  const statusCounts = {};
  let observedRateLimit = false;

  for (let i = 1; i <= 101; i++) {
    const response = await fetch(`${API_BASE_URL}/__rate-limit-test`);
    statusCounts[response.status] = (statusCounts[response.status] || 0) + 1;

    if (response.status === 429) {
      const result = await response.json();
      assert.deepEqual(result, {
        success: false,
        message: "Too many requests. Please try again later."
      });
      observedRateLimit = true;
    } else {
      await response.arrayBuffer();
    }

    if (i === 1 || i === 100 || i === 101) {
      console.log(`Request ${i}: HTTP ${response.status}`);
    }
  }

  assert.equal(observedRateLimit, true, "Expected at least one HTTP 429 response.");
  console.log("\nSummary:", statusCounts);
}

testApiRateLimit().catch((error) => {
  console.error("Rate limit test failed:", error.message);
  process.exitCode = 1;
});
