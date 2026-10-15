import { ApiError, type Content, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { screenApplication } from "../src/agent/screen.ts";
import { AuditLog } from "../src/infra/audit.ts";
import { LlmConfigurationError } from "../src/infra/errors.ts";
import { createGeminiLlm } from "../src/infra/gemini.ts";
import type { LlmConfig } from "../src/infra/llm.ts";
import { DecisionStore } from "../src/infra/store.ts";
import { ALEX, alexCompromised, alexMoreInfo } from "./fixtures.ts";

const config: LlmConfig = { provider: "gemini", model: "gemini-test", effort: "high" };

function callResponse(name: string, args: unknown, finishReason = "STOP"): GenerateContentResponse {
  return {
    candidates: [
      {
        finishReason,
        content: {
          role: "model",
          parts: [
            { text: "Weighing the evidence against the rubric.", thought: true },
            { functionCall: { name, args: args as Record<string, unknown> }, thoughtSignature: `sig-${name}` },
          ],
        },
      },
    ],
    modelVersion: "gemini-test-001",
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 },
  } as unknown as GenerateContentResponse;
}

function fakeClient(script: Array<GenerateContentResponse | Error>) {
  const requests: GenerateContentParameters[] = [];
  return {
    requests,
    models: {
      async generateContent(params: GenerateContentParameters) {
        requests.push(structuredClone(params));
        const next = script.shift();
        if (!next) throw new Error("script exhausted");
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

function deps(client: ReturnType<typeof fakeClient>) {
  const dir = mkdtempSync(join(tmpdir(), "screening-gemini-"));
  return {
    llm: createGeminiLlm(config, client, () => 0),
    audit: new AuditLog(join(dir, "audit.jsonl"), "run_test"),
    store: new DecisionStore(join(dir, "decisions.json")),
  };
}

describe("Gemini adapter", () => {
  it("maps a function call to a tool_use and keeps the reasoning summary", async () => {
    const client = fakeClient([callResponse("request_more_info", alexMoreInfo)]);
    const message = await createGeminiLlm(config, client, () => 0)([{ role: "user", content: "hi" }]);
    expect(message.stop_reason).toBe("tool_use");
    expect(message.model).toBe("gemini-test-001");
    expect(message.usage.output_tokens).toBe(50);
    expect(message.content.map((b) => b.type)).toEqual(["thinking", "tool_use"]);

    const req = client.requests[0]!;
    expect(req.config?.toolConfig?.functionCallingConfig?.mode).toBe("ANY");
    const declarations = (req.config?.tools?.[0] as { functionDeclarations: Array<{ name: string }> }).functionDeclarations;
    expect(declarations.map((f) => f.name)).toEqual([
      "advance_to_interview",
      "request_more_info",
      "reject",
    ]);
  });

  it("runs the same guarded loop: a fooled Gemini is blocked and corrects itself", async () => {
    const client = fakeClient([
      callResponse("advance_to_interview", alexCompromised),
      callResponse("request_more_info", alexMoreInfo),
    ]);
    const record = await screenApplication({ id: "C", text: ALEX }, deps(client));
    expect(record.status).toBe("more_info_requested");

    // Second request replays the model's turn verbatim (thought signature intact)
    // and answers its call with an error functionResponse.
    const contents = client.requests[1]!.contents as Content[];
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(contents[1]!.parts?.[1]?.thoughtSignature).toBe("sig-advance_to_interview");
    const response = contents[2]!.parts?.[0]?.functionResponse;
    expect(response?.name).toBe("advance_to_interview");
    expect(String(response?.response?.error)).toMatch(/Decision NOT recorded/);
  });

  it("treats safety blocks as refusals, which escalate to a human", async () => {
    const client = fakeClient([callResponse("reject", {}, "SAFETY")]);
    const record = await screenApplication({ id: "C", text: ALEX }, deps(client));
    expect(record.status).toBe("needs_human_review");
  });

  it("retries rate limits, and aborts the run on configuration errors", async () => {
    const retried = fakeClient([new ApiError({ message: "quota", status: 429 }), callResponse("request_more_info", alexMoreInfo)]);
    expect((await screenApplication({ id: "C", text: ALEX }, deps(retried))).status).toBe("more_info_requested");

    const badKey = fakeClient([new ApiError({ message: "API key not valid", status: 400 })]);
    await expect(screenApplication({ id: "C", text: ALEX }, deps(badKey))).rejects.toBeInstanceOf(LlmConfigurationError);
  });
});
