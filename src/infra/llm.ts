import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "../agent/prompt.ts";
import { DECISION_TOOLS } from "../agent/tools.ts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmConfig {
  model: string;
  effort: Effort;
}

/** The one capability the agent needs from a model. Swappable for a fake in tests. */
export type Llm = (messages: Anthropic.Beta.BetaMessageParam[]) => Promise<Anthropic.Beta.BetaMessage>;

export function loadLlmConfig(env = process.env): LlmConfig {
  return {
    model: env.SCREENING_MODEL ?? "claude-opus-5-5",
    effort: (env.SCREENING_EFFORT as Effort | undefined) ?? "high",
  };
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
