import OpenAI from "openai";
import "./environment.js";

let groq = null;

export function getGroqClient() {
  if (!groq) {
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
      const error = new Error("GROQ_API_KEY is missing from environment variables.");
      error.code = "GROQ_NOT_CONFIGURED";
      error.status = 503;
      throw error;
    }

    groq = new OpenAI({
      apiKey,
      baseURL: "https://api.groq.com/openai/v1"
    });
  }

  return groq;
}
