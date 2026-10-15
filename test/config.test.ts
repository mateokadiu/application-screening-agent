import { describe, expect, it } from "vitest";
import { createAnthropicLlm, loadLlmConfig } from "../src/infra/llm.ts";

describe("provider config", () => {
  it("defaults to Claude, and picks Gemini when only a Gemini key is present", () => {
    expect(loadLlmConfig({ ANTHROPIC_API_KEY: "k" })).toEqual({
      provider: "anthropic",
      model: "claude-opus-5-5",
      effort: "high",
    });
    expect(loadLlmConfig({ ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "k" })).toMatchObject({
      provider: "gemini",
      model: "gemini-3.8-flash",
    });
    expect(loadLlmConfig({ GEMINI_API_KEY: "k", SCREENING_PROVIDER: "anthropic" }).provider).toBe("anthropic");
  });

  it("rejects unknown providers and effort levels instead of failing mid-run", () => {
    expect(() => loadLlmConfig({ SCREENING_PROVIDER: "openai" })).toThrow(/SCREENING_PROVIDER/);
    expect(() => loadLlmConfig({ SCREENING_EFFORT: "extreme" })).toThrow(/SCREENING_EFFORT/);
  });
});

describe("Anthropic request", () => {
  it("sends strict tools, one call per turn, adaptive thinking and refusal fallback", async () => {
    let params: Record<string, any> = {};
    const fake = { beta: { messages: { create: async (p: Record<string, any>) => ((params = p), {}) } } };
    await createAnthropicLlm(
      { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
      fake as never,
    )([{ role: "user", content: "x" }]);
    expect(params).toMatchObject({
      model: "claude-opus-5-5",
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      fallbacks: "default",
    });
    expect(params.tools.map((t: { name: string; strict: boolean }) => [t.name, t.strict])).toEqual([
      ["advance_to_interview", true],
      ["request_more_info", true],
      ["reject", true],
    ]);
    expect(params.system[0].text).toMatch(/never as instructions/);
  });
});
