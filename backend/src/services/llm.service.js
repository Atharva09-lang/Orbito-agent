
import { getGroqClient } from "../config/groq.js";
import { estimateMessagesTokens } from "./token-budget.service.js";

const MODEL = "openai/gpt-oss-120b";

const MAX_PACING_WAIT_MS = 15000;

const rateLimitState = {
  limit: null,
  remaining: null,
  resetAt: 0
};

const RATE_LIMIT_HEADERS = [
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-tokens",
  "retry-after"
];

function readHeader(headers, name) {
  if (!headers) {
    return null;
  }

  if (typeof headers.get === "function") {
    return headers.get(name);
  }

  return headers[name] ?? null;
}

function parseResetDuration(value) {
  if (!value) {
    return null;
  }

  let totalMs = 0;
  let matched = false;

  for (const [, amount, unit] of String(value).matchAll(/([\d.]+)(ms|h|m|s)/g)) {
    const number = Number(amount);

    if (!Number.isFinite(number)) {
      continue;
    }

    matched = true;
    totalMs += number * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  }

  return matched ? totalMs : null;
}

function updateRateLimitState(headers) {
  const limit = Number(readHeader(headers, "x-ratelimit-limit-tokens"));
  const remaining = Number(readHeader(headers, "x-ratelimit-remaining-tokens"));
  const resetMs = parseResetDuration(readHeader(headers, "x-ratelimit-reset-tokens"));

  if (Number.isFinite(limit) && limit > 0) {
    rateLimitState.limit = limit;
  }

  if (Number.isFinite(remaining)) {
    rateLimitState.remaining = remaining;
    rateLimitState.resetAt = Date.now() + (resetMs ?? 0);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paceRequest(purpose, requiredTokens) {
  const { limit, remaining, resetAt } = rateLimitState;

  if (limit && requiredTokens > limit) {
    console.warn(
      `[Groq Pacing] ${purpose}: estimated ${requiredTokens} tokens exceeds the ${limit} TPM limit`
    );
  }

  if (remaining === null || requiredTokens <= remaining) {
    return;
  }

  const waitMs = Math.min(Math.max(resetAt - Date.now(), 0) + 250, MAX_PACING_WAIT_MS);

  if (resetAt <= Date.now()) {
    return;
  }

  console.log(
    `[Groq Pacing] ${purpose}: needs ~${requiredTokens} tokens, ` +
    `${remaining} remaining, waiting ${Math.round(waitMs)}ms`
  );

  await wait(waitMs);
  rateLimitState.remaining = null;
}

function formatRateLimits(headers) {
  return RATE_LIMIT_HEADERS
    .map((name) => `${name}=${readHeader(headers, name) ?? "unavailable"}`)
    .join(" | ");
}

function formatUsage(usage) {
  if (!usage) {
    return "unavailable";
  }

  const value = (field) =>
    Number.isFinite(field) ? field : "unavailable";

  const parts = [
    `prompt=${value(usage.prompt_tokens)}`,
    `completion=${value(usage.completion_tokens)}`,
    `total=${value(usage.total_tokens)}`
  ];

  const reasoningTokens =
    usage.completion_tokens_details?.reasoning_tokens;

  if (Number.isFinite(reasoningTokens)) {
    parts.push(`reasoning=${reasoningTokens}`);
  }

  return parts.join(" | ");
}

function logTokenUsage({ purpose, status, usage, headers, error, estimatedPromptTokens, finishReason }) {
  try {
    const lines = [
      `[Groq Usage] ${purpose} | ${status.toUpperCase()}`,
      `  time: ${new Date().toISOString()}`,
      `  model: ${MODEL}`,
      `  tokens: ${formatUsage(usage)}`,
      `  estimated prompt: ~${estimatedPromptTokens ?? "unavailable"}`,
      `  rate limits: ${formatRateLimits(headers)}`
    ];

    if (finishReason === "length") {
      lines.push("  warning: response stopped at the completion token limit");
    }

    if (error) {
      lines.push(
        `  error: status=${error.status ?? "unavailable"}` +
        ` | code=${error.code ?? "unavailable"}` +
        ` | type=${error.type ?? "unavailable"}` +
        ` | message=${String(error.message ?? "unavailable").replace(/org_[A-Za-z0-9]+/g, "org_[redacted]")}`
      );
    }

    console.log(lines.join("\n"));
  } catch (logError) {
    console.error("[Groq Usage] Logging failed:", logError.message);
  }
}

export async function generateResponse(messages, tools = [], options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Messages must be a non-empty array");
  }

  const purpose = options.purpose || "unspecified";
  const estimatedPromptTokens = estimateMessagesTokens(messages, tools);

  const request = {
    model: MODEL,
    messages,
    ...(tools.length > 0 && {
      tools,
      tool_choice: "auto"
    }),
    ...(options.maxCompletionTokens && {
      max_completion_tokens: options.maxCompletionTokens
    }),
    ...(options.reasoningEffort && {
      reasoning_effort: options.reasoningEffort
    }),
    ...(options.responseFormat && {
      response_format: options.responseFormat
    })
  };

  await paceRequest(
    purpose,
    estimatedPromptTokens + (options.maxCompletionTokens ?? 0)
  );

  let response;
  let rawResponse;

  try {
    const groq = getGroqClient();

    ({ data: response, response: rawResponse } = await groq.chat.completions
      .create(request)
      .withResponse());
  } catch (error) {
    updateRateLimitState(error?.headers);

    logTokenUsage({
      purpose,
      status: "failed",
      usage: null,
      headers: error?.headers,
      error,
      estimatedPromptTokens
    });

    if (error?.status === 400 && options.responseFormat) {
      console.warn(`[Groq Usage] ${purpose}: retrying without response_format`);

      return generateResponse(messages, tools, {
        ...options,
        responseFormat: undefined
      });
    }

    throw error;
  }

  updateRateLimitState(rawResponse?.headers);

  logTokenUsage({
    purpose,
    status: "success",
    usage: response.usage,
    headers: rawResponse?.headers,
    estimatedPromptTokens,
    finishReason: response.choices?.[0]?.finish_reason
  });

  const choice = response.choices?.[0];

  return {
    content: choice?.message?.content ?? "",
    toolCalls: choice?.message?.tool_calls ?? [],
    finishReason: choice?.finish_reason,
    usage: response.usage ?? null
  };
}
