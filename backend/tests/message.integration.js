import { randomUUID } from "node:crypto";

import { getAuthToken, API_BASE_URL } from "./helpers.js";

async function testMessage() {
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
        title: `Temporary message fixture ${randomUUID()}`
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

    const response = await fetch(
      `${API_BASE_URL}/messages/${conversationId}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "   " })
      }
    );

    const result = await response.json();

    console.log("HTTP Status:", response.status);
    console.log(JSON.stringify(result, null, 2));
    if (
      response.status !== 400 ||
      result.success !== false ||
      !Array.isArray(result.errors)
    ) {
      throw new Error(`Invalid message was not rejected as expected: ${JSON.stringify(result)}`);
    }
  } catch (error) {
    console.error("Test failed:", error.message);
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

testMessage();
