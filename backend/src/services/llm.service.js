
import groq from "../config/groq.js";

const MODEL = "openai/gpt-oss-120b";

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

function logTokenUsage({ purpose, status, usage, headers, error }) {
  try {
    const lines = [
      `[Groq Usage] ${purpose} | ${status.toUpperCase()}`,
      `  time: ${new Date().toISOString()}`,
      `  model: ${MODEL}`,
      `  tokens: ${formatUsage(usage)}`,
      `  rate limits: ${formatRateLimits(headers)}`
    ];

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

  let response;
  let rawResponse;

  try {
    ({ data: response, response: rawResponse } = await groq.chat.completions
      .create({
        model: MODEL,
        messages,
        ...(tools.length > 0 && {
          tools,
          tool_choice: "auto"
        })
      })
      .withResponse());
  } catch (error) {
    logTokenUsage({
      purpose,
      status: "failed",
      usage: null,
      headers: error?.headers,
      error
    });

    throw error;
  }

  logTokenUsage({
    purpose,
    status: "success",
    usage: response.usage,
    headers: rawResponse?.headers
  });

  const choice = response.choices?.[0];

  return {
    content: choice?.message?.content ?? "",
    toolCalls: choice?.message?.tool_calls ?? [],
    finishReason: choice?.finish_reason,
    usage: response.usage ?? null
  };
}
