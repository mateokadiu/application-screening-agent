import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "../agent/prompt.ts";
import { DECISION_TOOLS } from "../agent/tools.ts";
import { createGeminiLlm } from "./gemini.ts";

export { FatalLlmError } from "./errors.ts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Provider = "anthropic" | "gemini";

export interface LlmConfig {
  provider: Provider;
  model: string;
  effort: Effort;
}

/**
 * The one capability the agent needs from a model. The agent speaks the
 * Anthropic message format; other providers are adapted to it (see gemini.ts).
 * Swappable for a scripted fake in tests.
 */
export type Llm = (messages: Anthropic.Beta.BetaMessageParam[]) => Promise<Anthropic.Beta.BetaMessage>;

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-opus-5-5",
  gemini: "gemini-3.8-flash",
};

export const API_KEY_VAR: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function loadLlmConfig(env = process.env): LlmConfig {
  const provider = (env.SCREENING_PROVIDER ||
    (!env.ANTHROPIC_API_KEY && env.GEMINI_API_KEY ? "gemini" : "anthropic")) as Provider;
  if (!Object.hasOwn(DEFAULT_MODEL, provider))
    throw new Error(`Unknown SCREENING_PROVIDER "${provider}" (use anthropic or gemini).`);
  const effort = (env.SCREENING_EFFORT || "high") as Effort;
  if (!EFFORTS.includes(effort)) throw new Error(`Unknown SCREENING_EFFORT "${effort}" (use ${EFFORTS.join(", ")}).`);
  return { provider, model: env.SCREENING_MODEL || DEFAULT_MODEL[provider], effort };
}

export function createLlm(config: LlmConfig): Llm {
  return config.provider === "gemini" ? createGeminiLlm(config) : createAnthropicLlm(config);
}

export function createAnthropicLlm(config: LlmConfig, client = new Anthropic()): Llm {
  return (messages) =>
    client.beta.messages.create({
      model: config.model,
      max_tokens: 16000,
      // If the primary model declines, the API re-runs the request on a fallback
      // model. Which model actually answered is logged with every response.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: DECISION_TOOLS,
      // Forced tool choice isn't available on this model family, so the prompt
      // asks for a tool call and the agent loop re-prompts if none arrives.
      // One call per turn keeps "one application, one decision" unambiguous.
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: config.effort },
      messages,
    });
}
