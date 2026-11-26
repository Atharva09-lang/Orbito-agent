
import {
  createMessage,
  getConversationMessages,
  getRecentConversationMessages,
  markMessageFailed
} from "../repositories/message.repository.js";

import { runAgent } from "../services/agent.service.js";
import { extractAndSaveMemories } from "../services/memory.service.js";
import {
  getConversationSummary,
  updateConversationSummary
} from "../services/conversation-summary.service.js";
import {
  TOKEN_BUDGETS,
  trimMessagesToBudget
} from "../services/token-budget.service.js";


function isTokenLimitError(error) {
  if (error?.status === 429 || error?.status === 413) {
    return true;
  }

  const details = `${error?.code ?? ""} ${error?.type ?? ""} ${error?.message ?? ""}`;

  return /rate_limit|context_length|request_too_large|tokens? per|token limit/i.test(details);
}

const HISTORY_MESSAGE_LIMIT = 50;

function selectHistory(history, summary) {
  const coversUntil = summary?.coversUntil
    ? new Date(summary.coversUntil).getTime()
    : null;

  const unsummarized = coversUntil === null
    ? history
    : history.filter(
      (message) => new Date(message.created_at).getTime() > coversUntil
    );

  const { kept, dropped, usedTokens } = trimMessagesToBudget(
    unsummarized,
    TOKEN_BUDGETS.history
  );

  console.log(
    `[History] Sending ${kept.length} of ${history.length} messages ` +
    `(~${usedTokens} estimated tokens, budget ${TOKEN_BUDGETS.history}, ` +
    `summary: ${summary ? "yes" : "no"}, newly dropped: ${dropped.length})`
  );

  return { kept, dropped };
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
    const [history, summary] = await Promise.all([
      getRecentConversationMessages(
        req.user.id,
        conversationId,
        HISTORY_MESSAGE_LIMIT
      ),
      getConversationSummary(req.user.id, conversationId)
    ]);

    const { kept, dropped } = selectHistory(history, summary);

    const messages = kept.map(({ role, content }) => ({
      role,
      content
    }));

    const aiResponse = await runAgent(messages, {
      userId: req.user.id,
      conversationId,
      messageId: userMessage.id,
      historyMessageIds: kept.map((message) => message.id),
      conversationSummary: summary?.content ?? null
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

    res.status(201).json({
      success: true,
      message: "AI response generated successfully.",
      data: {
        userMessage,
        assistantMessage
      }
    });

    if (dropped.length >= TOKEN_BUDGETS.summaryMinMessages) {
      updateConversationSummary(
        req.user.id,
        conversationId,
        summary,
        dropped
      ).catch((summaryError) => {
        console.error("Summary update failed:", summaryError.message);
      });
    }

    return;

  } catch (error) {
    console.error("Message controller error:", error);

    if (userMessage && !assistantMessage) {
      try {
        await markMessageFailed(req.user.id, userMessage.id);
      } catch (markError) {
        console.error("Failed to mark message as failed:", markError.message);
      }
    }

    if (error?.code === "GROQ_NOT_CONFIGURED") {
      return res.status(503).json({
        success: false,
        message: "AI service is not configured."
      });
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
