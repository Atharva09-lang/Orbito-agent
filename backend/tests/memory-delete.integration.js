import { randomUUID } from "node:crypto";

import { getAuthToken, API_BASE_URL } from "./helpers.js";

async function testDeleteMemory() {
  let token;
  let memoryId;

  try {
    token = await getAuthToken();
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    };
    const createResponse = await fetch(`${API_BASE_URL}/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        memoryType: "fact",
        content: `Temporary memory DELETE fixture ${randomUUID()}.`,
        confidence: 0.95,
        importance: 2
      })
    });
    const createResult = await createResponse.json();
    if (
      createResponse.status !== 201 ||
      createResult.success !== true ||
      !createResult.memory?.id
    ) {
      throw new Error(`Memory fixture creation failed: ${JSON.stringify(createResult)}`);
    }
    memoryId = createResult.memory.id;

    const response = await fetch(`${API_BASE_URL}/memories/${memoryId}`, {
      method: "DELETE",
      headers
    });
    const result = await response.json();

    console.log("HTTP Status:", response.status);
    console.log(JSON.stringify(result, null, 2));
    if (response.status !== 200 || result.success !== true) {
      throw new Error(`Memory fixture deletion failed: ${JSON.stringify(result)}`);
    }
    memoryId = null;
  } catch (error) {
    console.error("Test failed:", error.message);
    process.exitCode = 1;
  } finally {
    if (memoryId) {
      try {
        await cleanupMemory(memoryId, token);
      } catch (error) {
        console.error("Cleanup failed:", error.message);
        process.exitCode = 1;
      }
    }
  }
}

async function cleanupMemory(memoryId, token) {
  const response = await fetch(`${API_BASE_URL}/memories/${memoryId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (response.status !== 200) {
    throw new Error(`Memory cleanup returned HTTP ${response.status}.`);
  }
  const result = await response.json();
  if (result.success !== true) {
    throw new Error("Memory cleanup did not return success true.");
  }
}

testDeleteMemory();
