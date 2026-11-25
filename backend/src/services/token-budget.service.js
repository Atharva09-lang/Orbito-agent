const CHARS_PER_TOKEN = 3.5;
const MESSAGE_OVERHEAD_TOKENS = 4;

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export const TOKEN_BUDGETS = Object.freeze({
  request: envInt("LLM_REQUEST_TOKEN_BUDGET", 5000),
  completion: envInt("LLM_COMPLETION_TOKENS", 1500),
  memoryCompletion: envInt("MEMORY_EXTRACTION_COMPLETION_TOKENS", 600),
  summaryCompletion: envInt("SUMMARY_COMPLETION_TOKENS", 500),
  history: envInt("HISTORY_TOKEN_BUDGET", 2500),
  finalHistory: envInt("FINAL_HISTORY_TOKEN_BUDGET", 1000),
  historical: envInt("HISTORICAL_CONTEXT_TOKEN_BUDGET", 800),
  memories: envInt("MEMORY_CONTEXT_TOKEN_BUDGET", 400),
  evidence: envInt("EVIDENCE_TOKEN_BUDGET", 2000),
  summary: envInt("SUMMARY_TOKEN_BUDGET", 400),
  summaryInput: envInt("SUMMARY_INPUT_TOKEN_BUDGET", 1500),
  summaryMinMessages: envInt("SUMMARY_MIN_MESSAGES", 8)
});

export function estimateTokens(text) {
  if (text === null || text === undefined) {
    return 0;
  }

  const value = typeof text === "string" ? text : JSON.stringify(text);

  return Math.ceil(value.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message) {
  return (
    MESSAGE_OVERHEAD_TOKENS +
    estimateTokens(message?.content) +
    (message?.tool_calls ? estimateTokens(message.tool_calls) : 0)
  );
}

export function estimateMessagesTokens(messages = [], tools = []) {
  const messageTokens = messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0
  );

  return messageTokens + (tools.length > 0 ? estimateTokens(tools) : 0);
}

export function truncateToTokens(text, maxTokens) {
  const value = String(text ?? "");
  const maxChars = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN));

  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function trimMessagesToBudget(messages, budget) {
  const kept = [];
  let usedTokens = 0;

  for (let index = messages.length - 1; index >= 0; index--) {
    const cost = estimateMessageTokens(messages[index]);

    if (kept.length > 0 && usedTokens + cost > budget) {
      break;
    }

    kept.unshift(messages[index]);
    usedTokens += cost;
  }

  return {
    kept,
    dropped: messages.slice(0, messages.length - kept.length),
    usedTokens
  };
}

export function fitListToBudget(items, budget, toText) {
  const kept = [];
  let usedTokens = 0;

  for (const item of items) {
    const cost = estimateTokens(toText(item));

    if (usedTokens + cost > budget) {
      continue;
    }

    kept.push(item);
    usedTokens += cost;
  }

  return { kept, usedTokens };
}
