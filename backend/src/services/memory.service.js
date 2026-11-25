
import { generateResponse } from "./llm.service.js";
import {
  createMemory,
  getRelevantMemories,
  getUserMemories,
  supersedeMemory
} from "../repositories/memory.repository.js";
import { TOKEN_BUDGETS, truncateToTokens } from "./token-budget.service.js";
import { extractKeywords } from "../utils/keywords.js";
import {
  analyzeMemoryAttribution,
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
- Every memory must include a non-empty "subject".
- "subject" is who that specific fact is about: "user" for the user,
  or a short label such as "user's sister" or "friend Rahul".
- Attribute every clause independently. A message that begins with "I"
  can still contain facts about other people.
- If one message contains facts about multiple people, return one memory
  item per distinct subject and fact, up to the 3-item limit.
- Never stop after extracting only the user's fact.
- Never assign all facts to the user merely because the message begins with "I".
- Never record a fact about another person as a fact about the user.
- Keep content neutral when possible, such as "Prefers Java for DSA.",
  and put the person's identity in "subject".
- Use the person's actual name when known. Use a relationship label such as
  "user's sister" only when no name is known; do not invent relationships.
- If the subject is unclear or ambiguous, omit that memory.

Few-shot examples:
Input: "I prefer C++. My friend Rahul prefers Java."
Output: {"memories":[
  {"action":"add","replaces_id":null,"subject":"user","memory_type":"preference","content":"Prefers C++ for DSA.","duration":"permanent","expires_in_days":null,"confidence":0.97,"importance":4},
  {"action":"add","replaces_id":null,"subject":"friend Rahul","memory_type":"preference","content":"Prefers Java for DSA.","duration":"permanent","expires_in_days":null,"confidence":0.97,"importance":4}
]}
Input: "I prefer Node.js for backend development. Rahul prefers Python."
Output: {"memories":[
  {"action":"add","replaces_id":null,"subject":"user","memory_type":"preference","content":"Prefers Node.js for backend development.","duration":"permanent","expires_in_days":null,"confidence":0.97,"importance":4},
  {"action":"add","replaces_id":null,"subject":"Rahul","memory_type":"preference","content":"Prefers Python for backend development.","duration":"permanent","expires_in_days":null,"confidence":0.97,"importance":4}
]}
Input: "I prefer Java. My sister prefers Python."
Output: {"memories":[
  {"action":"add","replaces_id":null,"subject":"user","memory_type":"preference","content":"Prefers Java.","duration":"permanent","expires_in_days":null,"confidence":0.97,"importance":4},
  {"action":"add","replaces_id":null,"subject":"user's sister","memory_type":"preference","content":"Prefers Python.","duration":"permanent","expires_in_days":null,"confidence":0.97,"importance":4}
]}

Duration rules:
- "permanent" for stable facts and long-term preferences.
- "temporary" for short-lived context such as plans for this week;
  set "expires_in_days" between 1 and 90.

Update rules:
- If the message changes or contradicts an existing memory with the same
  subject and type, use action "update" and set "replaces_id" to that id.
- Use "update" only when replaces_id is one of the existing related memory ids.
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

  let plan;

  try {
    const [relatedMemories, existingMemories] = await Promise.all([
      getRelevantMemories(userId, extractKeywords(message), 100),
      getUserMemories(userId, 100)
    ]);

    const candidates = relatedMemories
      .filter((memory) => !analyzeMemoryAttribution(memory.content).ambiguous)
      .slice(0, CANDIDATE_LIMIT);
    const attributableExisting = existingMemories
      .filter((memory) => !analyzeMemoryAttribution(memory.content).ambiguous);

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

    plan = planMemoryActions(
      parsed.memories,
      candidates,
      attributableExisting
    );
  } catch (error) {
    console.error("Memory extraction failed:", error.message);
    return [];
  }

  const savedMemories = [];
  let supersededCount = 0;

  for (const step of plan) {
    if (step.type === "skip") {
      continue;
    }

    if (step.type === "supersede") {
      const result = await supersedeMemory(
        userId,
        step.replacesId,
        step.memory.memoryType,
        step.memory.content,
        {
          confidence: step.memory.confidence,
          importance: step.memory.importance,
          expiresAt: step.memory.expiresAt,
          sourceMessageId
        }
      );

      if (result.status !== "superseded") {
        console.error(`Memory supersede skipped: ${result.status}`);
        continue;
      }

      savedMemories.push(result.memory);
      supersededCount++;
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
      console.error("Memory insert skipped: invalid source message.");
      continue;
    }

    savedMemories.push(saved);
  }

  console.log(
    `Memories saved: ${savedMemories.length}, superseded: ${supersededCount}, ` +
    `skipped: ${plan.filter((step) => step.type === "skip").length}`
  );

  return savedMemories;
}
