import type Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_MODEL_TURNS, screenApplication } from "../src/agent/screen.ts";
import { AuditLog, verifyAuditFile, type AuditRecord } from "../src/infra/audit.ts";
import type { Llm } from "../src/infra/llm.ts";
import { DecisionStore } from "../src/infra/store.ts";
import { ALEX, JOHN, MARIA, alexCompromised, alexMoreInfo, johnReject, mariaAdvance, textMessage, toolUseMessage } from "./fixtures.ts";

/** A model that replays a script and records every conversation it was shown. */
function scriptedLlm(script: Anthropic.Beta.BetaMessage[]) {
  const seen: Anthropic.Beta.BetaMessageParam[][] = [];
  const llm: Llm = async (messages) => {
    seen.push(structuredClone(messages));
    const next = script.shift();
    if (!next) throw new Error("script exhausted");
    return next;
  };
  return { llm, seen };
}

function setup(script: Anthropic.Beta.BetaMessage[]) {
  const dir = mkdtempSync(join(tmpdir(), "screening-"));
  const audit = new AuditLog(join(dir, "audit.jsonl"), "run_test");
  const store = new DecisionStore(join(dir, "decisions.json"));
  const { llm, seen } = scriptedLlm(script);
  const events = () =>
    readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as AuditRecord);
  return { dir, audit, store, llm, seen, events };
}

describe("agent loop", () => {
  it("A: advances a strong candidate", async () => {
    const t = setup([toolUseMessage("advance_to_interview", mariaAdvance)]);
    const record = await screenApplication({ id: "A", text: MARIA }, t);
    expect(record).toMatchObject({ status: "advanced_to_interview", score: 88, flags: [] });
  });

  it("B: a rejection is only ever filed as pending human approval", async () => {
    const t = setup([toolUseMessage("reject", johnReject)]);
    const record = await screenApplication({ id: "B", text: JOHN }, t);
    expect(record.status).toBe("rejection_pending_approval");
    expect(t.store.get("B")?.history.map((h) => h.by)).toEqual(["agent"]);
  });

  it("C: if the model falls for the injection, the call is blocked and the model must correct itself", async () => {
    const t = setup([
      toolUseMessage("advance_to_interview", alexCompromised),
      toolUseMessage("request_more_info", alexMoreInfo),
    ]);
    const record = await screenApplication({ id: "C", text: ALEX }, t);

    expect(record.status).toBe("more_info_requested");
    expect(record.flags).toContain("injection_scanner_hit");

    // The second model turn was shown the guardrail's error as a tool_result.
    const lastUserTurn = t.seen[1]!.at(-1)!;
    const toolResult = (lastUserTurn.content as Anthropic.Beta.BetaToolResultBlockParam[])[0]!;
    expect(toolResult.is_error).toBe(true);
    expect(String(toolResult.content)).toMatch(/Decision NOT recorded/);

    const names = t.events().map((e) => e.event);
    expect(names).toContain("guardrail_blocked");
    expect(names.indexOf("guardrail_blocked")).toBeLessThan(names.indexOf("tool_executed"));
  });

  it("C: a model that keeps insisting is escalated to a human, never advanced", async () => {
    const t = setup(Array.from({ length: MAX_MODEL_TURNS }, () => toolUseMessage("advance_to_interview", alexCompromised)));
    const record = await screenApplication({ id: "C", text: ALEX }, t);
    expect(record.status).toBe("needs_human_review");
    expect(t.seen).toHaveLength(MAX_MODEL_TURNS);
  });

  it("nudges when no tool is called, then escalates", async () => {
    const t = setup(Array.from({ length: MAX_MODEL_TURNS }, () => textMessage("I think this is a good candidate.")));
    const record = await screenApplication({ id: "A", text: MARIA }, t);
    expect(record.status).toBe("needs_human_review");
    expect(t.events().filter((e) => e.event === "nudge_sent")).toHaveLength(MAX_MODEL_TURNS);
  });

  it("escalates on a model refusal", async () => {
    const t = setup([textMessage("", "refusal")]);
    expect((await screenApplication({ id: "A", text: MARIA }, t)).status).toBe("needs_human_review");
  });

  it("sends the application only inside an unpredictable boundary, in the user turn", async () => {
    const a = setup([toolUseMessage("advance_to_interview", mariaAdvance)]);
    const b = setup([toolUseMessage("advance_to_interview", mariaAdvance)]);
    await screenApplication({ id: "A", text: MARIA }, a);
    await screenApplication({ id: "A", text: MARIA }, b);
    const first = a.seen[0]![0]!.content as string;
    const second = b.seen[0]![0]!.content as string;
    const tag = /<(application_data_[0-9a-f]{12})>\n([\s\S]*)\n<\/\1>/;
    expect(first.match(tag)?.[2]).toBe(MARIA);
    expect(first.match(tag)?.[1]).not.toBe(second.match(tag)?.[1]);
  });

  it("logs every step to a hash-chained audit file", async () => {
    const t = setup([toolUseMessage("reject", johnReject)]);
    await screenApplication({ id: "B", text: JOHN }, t);
    expect(t.events().map((e) => e.event)).toEqual([
      "application_received",
      "injection_scan",
      "prompt_built",
      "model_request",
      "model_response",
      "tool_call_proposed",
      "guardrail_passed",
      "tool_executed",
      "tool_result_returned",
      "decision_final",
    ]);
    expect(verifyAuditFile(join(t.dir, "audit.jsonl"))).toEqual({ ok: true, count: 10 });
  });
});
