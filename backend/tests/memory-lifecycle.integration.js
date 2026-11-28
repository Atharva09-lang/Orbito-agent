import { randomUUID } from "node:crypto";

import { getAuthToken, API_BASE_URL } from "./helpers.js";

async function testMemoryLifecycle() {
  let memoryId = null;
  let token;

  const headers = {
    "Content-Type": "application/json"
  };

  try {
    token = await getAuthToken();
    headers.Authorization = `Bearer ${token}`;

    // 1. Create memory
    const originalContent = `Temporary memory lifecycle fixture ${randomUUID()}.`;
    const createResponse = await fetch(`${API_BASE_URL}/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        memoryType: "fact",
        content: originalContent,
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
      throw new Error(`Memory creation failed: ${JSON.stringify(createResult)}`);
    }

    memoryId = createResult.memory.id;
    console.log("PASS: Memory created — HTTP", createResponse.status);

    // 2. Update memory
    const updatedContent = `Updated temporary memory lifecycle fixture ${randomUUID()}.`;
    const updateResponse = await fetch(
      `${API_BASE_URL}/memories/${memoryId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          content: updatedContent
        })
      }
    );

    const updateResult = await updateResponse.json();

    if (
      updateResponse.status !== 200 ||
      updateResult.success !== true ||
      updateResult.memory?.id !== memoryId ||
      updateResult.memory?.content !== updatedContent
    ) {
      throw new Error(`Memory update failed: ${JSON.stringify(updateResult)}`);
    }

    console.log("PASS: Memory updated — HTTP", updateResponse.status);

    // 3. Delete memory
    const deleteResponse = await fetch(
      `${API_BASE_URL}/memories/${memoryId}`,
      {
        method: "DELETE",
        headers
      }
    );

    const deleteResult = await deleteResponse.json();

    if (deleteResponse.status !== 200 || deleteResult.success !== true) {
      throw new Error(`Memory deletion failed: ${JSON.stringify(deleteResult)}`);
    }

    memoryId = null;
    console.log("PASS: Memory deactivated — HTTP", deleteResponse.status);

    console.log("\nPASS: Complete memory lifecycle test.");
  } catch (error) {
    console.error("\nFAIL:", error.message);
    process.exitCode = 1;
  } finally {
    // Clean up if an earlier step failed
    if (memoryId && token) {
      try {
        const cleanupResponse = await fetch(
          `${API_BASE_URL}/memories/${memoryId}`,
          {
            method: "DELETE",
            headers
          }
        );

        if (cleanupResponse.status !== 200) {
          throw new Error(`Cleanup failed: HTTP ${cleanupResponse.status}.`);
        }
        const cleanupResult = await cleanupResponse.json();
        if (cleanupResult.success !== true) {
          throw new Error("Cleanup failed: success contract not satisfied.");
        }
        console.log("Cleanup: Temporary memory deactivated.");
      } catch (error) {
        console.error("Cleanup failed:", error.message);
        process.exitCode = 1;
      }
    }
  }
}

testMemoryLifecycle();
