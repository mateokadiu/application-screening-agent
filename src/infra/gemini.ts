import type Anthropic from "@anthropic-ai/sdk";
import {
  ApiError,
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { SYSTEM_PROMPT } from "../agent/prompt.ts";
import { DECISION_TOOLS } from "../agent/tools.ts";
import { LlmConfigurationError } from "./errors.ts";
import type { Effort, Llm, LlmConfig } from "./llm.ts";

/**
 * Gemini adapter. Translates the agent's Anthropic-format conversation to
 * Gemini `contents` and the reply back, so the agent loop, guardrails and
 * logging are identical whichever model runs behind them.
 */

export interface GeminiClient {
  models: { generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse> };
}

const THINKING_LEVEL: Record<Effort, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
  xhigh: ThinkingLevel.HIGH,
  max: ThinkingLevel.HIGH,
};

const REFUSAL_REASONS = new Set(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "RECITATION"]);
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const CONFIG_STATUS = new Set([400, 401, 403, 404]);
const MAX_ATTEMPTS = 4;

export function createGeminiLlm(
  config: LlmConfig,
  client: GeminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }),
  backoffMs = (attempt: number) => 2000 * 2 ** attempt,
): Llm {
  // Gemini attaches thought signatures to its turns and expects them back
  // verbatim, so each assistant turn is replayed from the original Content.
  const originalTurns = new WeakMap<object, Content>();
  const toolNames = new Map<string, string>();
  const geminiCallIds = new Map<string, string | undefined>();

  const tools = [
    {
      functionDeclarations: DECISION_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: t.input_schema,
      })),
    },
  ];

  function toContents(messages: Anthropic.Beta.BetaMessageParam[]): Content[] {
    const contents: Content[] = [];
    for (const m of messages) {
      if (typeof m.content === "string") {
        contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
        continue;
      }
      if (m.role === "assistant") {
        const original = originalTurns.get(m.content);
        if (original) {
          contents.push(original);
          continue;
        }
      }
      const parts: Part[] = [];
      for (const block of m.content) {
        if (block.type === "text") parts.push({ text: block.text });
        if (block.type === "tool_use") parts.push({ functionCall: { name: block.name, args: block.input as Record<string, unknown> } });
        if (block.type === "tool_result") {
          const output = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          parts.push({
            functionResponse: {
              id: geminiCallIds.get(block.tool_use_id),
              name: toolNames.get(block.tool_use_id),
              response: block.is_error ? { error: output } : { output },
            },
          });
        }
      }
      contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
    }
    return contents;
  }

  function toMessage(res: GenerateContentResponse): Anthropic.Beta.BetaMessage {
    const candidate = res.candidates?.[0];
    const content: unknown[] = [];

    for (const part of candidate?.content?.parts ?? []) {
      if (part.thought && part.text) {
        content.push({ type: "thinking", thinking: part.text, signature: "" });
      } else if (part.functionCall?.name) {
        const id = part.functionCall.id ?? `toolu_gem_${randomBytes(6).toString("hex")}`;
        toolNames.set(id, part.functionCall.name);
        geminiCallIds.set(id, part.functionCall.id);
        content.push({ type: "tool_use", id, name: part.functionCall.name, input: part.functionCall.args ?? {} });
      } else if (part.text) {
        content.push({ type: "text", text: part.text, citations: null });
      }
    }
    if (candidate?.content) originalTurns.set(content, candidate.content);

    const finish = candidate?.finishReason ?? "";
    const stop_reason =
      res.promptFeedback?.blockReason || REFUSAL_REASONS.has(finish) || !candidate
        ? "refusal"
        : finish === "MAX_TOKENS"
          ? "max_tokens"
          : content.some((b) => (b as { type: string }).type === "tool_use")
            ? "tool_use"
            : "end_turn";

    const usage = res.usageMetadata;
    return {
      id: res.responseId ?? `gem_${randomBytes(6).toString("hex")}`,
      type: "message",
      role: "assistant",
      model: res.modelVersion ?? config.model,
      content,
      stop_reason,
      stop_sequence: null,
      usage: {
        input_tokens: usage?.promptTokenCount ?? 0,
        output_tokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
        cache_read_input_tokens: usage?.cachedContentTokenCount ?? 0,
        cache_creation_input_tokens: 0,
      },
    } as unknown as Anthropic.Beta.BetaMessage;
  }

  return async (messages) => {
    const params: GenerateContentParameters = {
      model: config.model,
      contents: toContents(messages),
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools,
        // Gemini supports forcing a function call, so a text-only reply can't happen.
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } },
        thinkingConfig: { includeThoughts: true, thinkingLevel: THINKING_LEVEL[config.effort] },
        maxOutputTokens: 16000,
      },
    };

    for (let attempt = 0; ; attempt++) {
      try {
        return toMessage(await client.models.generateContent(params));
      } catch (err) {
        if (err instanceof ApiError && CONFIG_STATUS.has(err.status)) {
          throw new LlmConfigurationError(`Gemini rejected the request (${err.status}): ${err.message}`);
        }
        const retryable = err instanceof ApiError && RETRYABLE_STATUS.has(err.status);
        if (!retryable || attempt + 1 >= MAX_ATTEMPTS) throw err;
        await sleep(backoffMs(attempt));
      }
    }
  };
}
