
import { generateResponse } from "./llm.service.js";
import {
  createMemory,
  deactivateMemory,
  getRelevantMemories,
  getUserMemories
} from "../repositories/memory.repository.js";
import { TOKEN_BUDGETS, truncateToTokens } from "./token-budget.service.js";
import { extractKeywords } from "../utils/keywords.js";
import {
  parseMemorySubject,
  planMemoryActions
} from "../utils/memory-format.js";

const CANDIDATE_LIMIT = 12;

const EXTRACTION_PROMPT = `
You are Orbito's memory extraction system.

Analyze the user's latest message and decide what is worth remembering
for future conversations. You are also given the user's existing related
memories, each with an id.

Extract only:
- Stable facts explicitly stated by the user.
- Long-term preferences.
- Important goals.
- Ongoing commitments or projects.

Subject rules:
- "subject" is who the memory is about: "user" for the user,
  or a short label such as "user's sister" or "friend Rahul".
- Never record a fact about another person as a fact about the user.

Duration rules:
- "permanent" for stable facts and long-term preferences.
- "temporary" for short-lived context such as plans for this week;
  set "expires_in_days" between 1 and 90.

Update rules:
- If the message changes or contradicts an existing memory with the same
  subject and type, use action "update" and set "replaces_id" to that id.
- Only update when the user clearly states a lasting change.
- If the information is already saved, use action "none".
- Otherwise use action "add" with "replaces_id" null.

Rules:
- Do not extract temporary questions or casual conversation.
- Do not infer facts that the user did not state.
- Do not save passwords, API keys, tokens or credentials.
- Do not extract sensitive personal information.
- Return at most 3 items.
- If nothing is worth remembering, return an empty array.
- memory_type must be fact, preference, commitment, goal or other.
- confidence must be between 0 and 1.
- importance must be an integer between 1 and 5.
- content must describe the subject in one short sentence.

Return only valid JSON in this format:

{
  "memories": [
    {
      "action": "add",
      "replaces_id": null,
      "subject": "user",
      "memory_type": "preference",
      "content": "Prefers Node.js for backend development.",
      "duration": "permanent",
      "expires_in_days": null,
      "confidence": 0.95,
      "importance": 4
    }
  ]
}
`;

function parseExtractionResult(content) {
  const text = String(content ?? "")
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "");

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start === -1 || end <= start) {
      throw new Error("Memory extraction returned invalid JSON.");
    }

    return JSON.parse(text.slice(start, end + 1));
  }
}

function formatCandidates(candidates) {
  if (candidates.length === 0) {
    return "Existing related memories: none";
  }

  return `Existing related memories:\n${candidates
    .map((memory) => {
      const { subject, text } = parseMemorySubject(memory.content);

      return `- id: ${memory.id} | type: ${memory.memory_type} | subject: ${subject} | ${truncateToTokens(text, 60)}`;
    })
    .join("\n")}`;
}

export async function extractAndSaveMemories(
  userId,
  message,
  sourceMessageId
) {
  if (!userId || !message || !sourceMessageId) {
    return [];
  }

  try {
    const [relatedMemories, existingMemories] = await Promise.all([
      getRelevantMemories(userId, extractKeywords(message), 30),
      getUserMemories(userId, 100)
    ]);

    const candidates = relatedMemories.slice(0, CANDIDATE_LIMIT);

    const result = await generateResponse([
      {
        role: "system",
        content: `${EXTRACTION_PROMPT}\n${formatCandidates(candidates)}`
      },
      {
        role: "user",
        content: message
      }
    ], [], {
      purpose: "memory_extraction",
      maxCompletionTokens: TOKEN_BUDGETS.memoryCompletion,
      reasoningEffort: "low",
      responseFormat: { type: "json_object" }
    });

    const parsed = parseExtractionResult(result.content);

    if (!Array.isArray(parsed.memories)) {
      return [];
    }

    const plan = planMemoryActions(
      parsed.memories,
      candidates,
      existingMemories
    );

    const savedMemories = [];
    let supersededCount = 0;

    for (const step of plan) {
      if (step.type === "skip") {
        continue;
      }

      const saved = await createMemory(
        userId,
        step.memory.memoryType,
        step.memory.content,
        {
          confidence: step.memory.confidence,
          importance: step.memory.importance,
          expiresAt: step.memory.expiresAt,
          sourceMessageId
        }
      );

      if (!saved) {
        continue;
      }

      savedMemories.push(saved);

      if (step.type === "supersede") {
        const deactivated = await deactivateMemory(userId, step.replacesId);

        if (deactivated) {
          supersededCount++;
        }
      }
    }

    console.log(
      `Memories saved: ${savedMemories.length}, superseded: ${supersededCount}, ` +
      `skipped: ${plan.filter((step) => step.type === "skip").length}`
    );

    return savedMemories;
  } catch (error) {
    console.error("Memory extraction failed:", error.message);
    return [];
  }
}
