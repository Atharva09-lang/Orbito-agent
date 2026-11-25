
import {
  createMessage,
  getConversationMessages,
  getRecentConversationMessages,
  markMessageFailed
} from "../repositories/message.repository.js";

import { runAgent } from "../services/agent.service.js";
import { extractAndSaveMemories } from "../services/memory.service.js";


function isTokenLimitError(error) {
  if (error?.status === 429 || error?.status === 413) {
    return true;
  }

  const details = `${error?.code ?? ""} ${error?.type ?? ""} ${error?.message ?? ""}`;

  return /rate_limit|context_length|request_too_large|tokens? per|token limit/i.test(details);
}

const HISTORY_MESSAGE_LIMIT = 50;
const HISTORY_TOKEN_BUDGET = 3000;

function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 4) + 4;
}

function trimHistoryToTokenBudget(messages, budget) {
  const kept = [];
  let usedTokens = 0;

  for (let index = messages.length - 1; index >= 0; index--) {
    const cost = estimateTokens(messages[index].content);

    if (kept.length > 0 && usedTokens + cost > budget) {
      break;
    }

    kept.unshift(messages[index]);
    usedTokens += cost;
  }

  console.log(
    `[History] Sending ${kept.length} of ${messages.length} messages ` +
    `(~${usedTokens} estimated tokens, budget ${budget})`
  );

  return kept;
}

export async function createMessageController(req, res) {
  let userMessage = null;
  let assistantMessage = null;

  try {
    const { content, role = "user", metadata = {} } = req.body;
    const conversationId = req.params.conversationId;

    if (role !== "user") {
      return res.status(400).json({
        success: false,
        message: "Only user messages are allowed."
      });
    }

    if (typeof content !== "string" || !content.trim()) {
      return res.status(400).json({
        success: false,
        message: "Message content is required."
      });
    }


    userMessage = await createMessage(
      req.user.id,
      conversationId,
      "user",
      content.trim(),
      metadata
    );

    if (!userMessage) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found."
      });
    }

   await extractAndSaveMemories(
        req.user.id,
        content.trim(),
        userMessage.id
    );
    const history = await getRecentConversationMessages(
      req.user.id,
      conversationId,
      HISTORY_MESSAGE_LIMIT
    );

    const messages = trimHistoryToTokenBudget(
      history.map(({ role, content }) => ({
        role,
        content
      })),
      HISTORY_TOKEN_BUDGET
    );

  
    const aiResponse = await runAgent(messages, {
      userId: req.user.id,
      conversationId,
      messageId: userMessage.id
    });


    assistantMessage = await createMessage(
      req.user.id,
      conversationId,
      "assistant",
      aiResponse.content,
      {
        usage: aiResponse.usage,
        finishReason: aiResponse.finishReason
      }
    );

    return res.status(201).json({
      success: true,
      message: "AI response generated successfully.",
      data: {
        userMessage,
        assistantMessage
      }
    });

  } catch (error) {
    console.error("Message controller error:", error);

    if (userMessage && !assistantMessage) {
      try {
        await markMessageFailed(req.user.id, userMessage.id);
      } catch (markError) {
        console.error("Failed to mark message as failed:", markError.message);
      }
    }

    if (isTokenLimitError(error)) {
      return res.status(429).json({
        success: false,
        message: "Token limit exceeded. Please try again later."
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to process message."
    });
  }
}



export async function getMessagesController(req, res) {
  try {
    const conversationId = req.params.conversationId;

    const messages = await getConversationMessages(
      req.user.id,
      conversationId
    );

    return res.status(200).json({
      success: true,
      data: messages
    });

  } catch (error) {
    console.error("Get messages error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch messages."
    });
  }
}
