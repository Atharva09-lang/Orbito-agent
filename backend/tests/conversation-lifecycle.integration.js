import { randomUUID } from "node:crypto";

import { getAuthToken, API_BASE_URL } from "./helpers.js";

async function testConversationLifecycle() {
  let conversationId = null;
  let token;

  const headers = {
    "Content-Type": "application/json"
  };

  try {
    token = await getAuthToken();
    headers.Authorization = `Bearer ${token}`;

    // 1. Create conversation
    const createResponse = await fetch(
      `${API_BASE_URL}/conversations`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: `Temporary conversation lifecycle fixture ${randomUUID()}`
        })
      }
    );

    const createResult = await createResponse.json();

    if (
      createResponse.status !== 201 ||
      createResult.success !== true ||
      !createResult.conversation?.id
    ) {
      throw new Error(`Creation failed: ${JSON.stringify(createResult)}`);
    }

    conversationId = createResult.conversation.id;
    console.log("PASS: Conversation created — HTTP", createResponse.status);

    // 2. Get all conversations
    const listResponse = await fetch(
      `${API_BASE_URL}/conversations`,
      { headers }
    );

    const listResult = await listResponse.json();

    if (
      listResponse.status !== 200 ||
      listResult.success !== true ||
      !Array.isArray(listResult.conversations) ||
      !listResult.conversations.some(
        (item) => item.id === conversationId
      )
    ) {
      throw new Error("Created conversation missing from list.");
    }

    console.log("PASS: Conversation list — HTTP", listResponse.status);

    // 3. Get one conversation
    const getResponse = await fetch(
      `${API_BASE_URL}/conversations/${conversationId}`,
      { headers }
    );

    const getResult = await getResponse.json();

    if (
      getResponse.status !== 200 ||
      getResult.success !== true ||
      getResult.conversation?.id !== conversationId
    ) {
      throw new Error("Could not retrieve created conversation.");
    }

    console.log("PASS: Get conversation — HTTP", getResponse.status);

    // 4. Update conversation title
    const updatedTitle = `Updated conversation lifecycle fixture ${randomUUID()}`;
    const updateResponse = await fetch(
      `${API_BASE_URL}/conversations/${conversationId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          title: updatedTitle
        })
      }
    );

    const updateResult = await updateResponse.json();

    if (
      updateResponse.status !== 200 ||
      updateResult.success !== true ||
      updateResult.conversation?.id !== conversationId ||
      updateResult.conversation?.title !== updatedTitle
    ) {
      throw new Error(`Update failed: ${JSON.stringify(updateResult)}`);
    }

    console.log("PASS: Conversation updated — HTTP", updateResponse.status);

    // 5. Delete conversation
    const deleteResponse = await fetch(
      `${API_BASE_URL}/conversations/${conversationId}`,
      {
        method: "DELETE",
        headers
      }
    );

    const deleteResult = await deleteResponse.json();

    if (deleteResponse.status !== 200 || deleteResult.success !== true) {
      throw new Error(`Delete failed: ${JSON.stringify(deleteResult)}`);
    }

    conversationId = null;
    console.log("PASS: Conversation deleted — HTTP", deleteResponse.status);

    console.log("\nPASS: Complete conversation lifecycle test.");

  } catch (error) {
    console.error("\nFAIL:", error.message);
    process.exitCode = 1;

  } finally {
    if (conversationId && token) {
      try {
        const cleanupResponse = await fetch(
          `${API_BASE_URL}/conversations/${conversationId}`,
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
        console.log("Cleanup: Temporary conversation deleted.");
      } catch (error) {
        console.error("Cleanup failed:", error.message);
        process.exitCode = 1;
      }
    }
  }
}

testConversationLifecycle();
