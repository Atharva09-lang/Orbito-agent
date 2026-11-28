import { randomUUID } from "node:crypto";

import { getAuthToken, API_BASE_URL } from "./helpers.js";

async function runTest(name, url, options, expectedStatus = 400) {
  const response = await fetch(url, options);
  const result = await response.json();

  const passed =
    response.status === expectedStatus &&
    result.success === false &&
    Array.isArray(result.errors);

  console.log(
    `${passed ? "PASS" : "FAIL"}: ${name} — HTTP ${response.status}`
  );

  if (!passed) {
    console.log(result);
    process.exitCode = 1;
  }
}

async function testValidation() {
  let token;
  let conversationId;

  try {
    token = await getAuthToken();
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    };
    const createResponse = await fetch(`${API_BASE_URL}/conversations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: `Temporary validation fixture ${randomUUID()}`
      })
    });
    const createResult = await createResponse.json();
    if (
      createResponse.status !== 201 ||
      createResult.success !== true ||
      !createResult.conversation?.id
    ) {
      throw new Error(`Conversation fixture creation failed: ${JSON.stringify(createResult)}`);
    }
    conversationId = createResult.conversation.id;

    const messageUrl = `${API_BASE_URL}/messages/${conversationId}`;
    const memoryUrl = `${API_BASE_URL}/memories`;

    console.log("\nTesting Zod validation...\n");

    await runTest(
      "Empty message rejected",
      messageUrl,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "   " })
      }
    );

    await runTest(
      "Invalid message role rejected",
      messageUrl,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          content: "Hello",
          role: "assistant"
        })
      }
    );

    await runTest(
      "Invalid memory type rejected",
      memoryUrl,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          memoryType: "invalid",
          content: "Test memory"
        })
      }
    );

    await runTest(
      "Invalid memory ID rejected",
      `${memoryUrl}/not-a-uuid`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          content: "Updated test memory"
        })
      }
    );
  } catch (error) {
    console.error("Validation test failed:", error.message);
    process.exitCode = 1;
  } finally {
    if (conversationId) {
      try {
        await cleanupConversation(conversationId, token);
      } catch (error) {
        console.error("Cleanup failed:", error.message);
        process.exitCode = 1;
      }
    }
  }
}

async function cleanupConversation(conversationId, token) {
  const response = await fetch(`${API_BASE_URL}/conversations/${conversationId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (response.status !== 200) {
    throw new Error(`Conversation cleanup returned HTTP ${response.status}.`);
  }
  const result = await response.json();
  if (result.success !== true) {
    throw new Error("Conversation cleanup did not return success true.");
  }
}

testValidation();
