import { randomUUID } from "node:crypto";

import { getAuthToken, API_BASE_URL } from "./helpers.js";

async function testRateLimit() {
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
        title: `Temporary rate-limit fixture ${randomUUID()}`
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

    const apiUrl = `${API_BASE_URL}/messages/${conversationId}`;
    const invalidRequestBody = JSON.stringify({
      role: "assistant",
      content: "Rate limit test"
    });

    console.log("Sending 21 provider-free invalid requests...\n");

    for (let i = 1; i <= 20; i++) {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers,
        body: invalidRequestBody
      });
      const result = await response.json();

      if (
        response.status !== 400 ||
        result.success !== false ||
        !Array.isArray(result.errors)
      ) {
        throw new Error(
          `Request ${i}: expected HTTP 400 validation rejection, received HTTP ${response.status}: ${JSON.stringify(result)}`
        );
      }

      console.log(`Request ${i}: HTTP ${response.status}`);
    }

    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: invalidRequestBody
    });
    const result = await response.json();

    if (response.status !== 429 || result.success !== false) {
      throw new Error(
        `Request 21: expected HTTP 429 with success false, received HTTP ${response.status}: ${JSON.stringify(result)}`
      );
    }

    console.log(`Request 21: HTTP ${response.status}`);
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

testRateLimit();
