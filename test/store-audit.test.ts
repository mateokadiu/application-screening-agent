import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, verifyAuditFile } from "../src/infra/audit.ts";
import { DecisionStore } from "../src/infra/store.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "screening-"));

describe("decision store", () => {
  const entry = { application_id: "B", run_id: "r", score: 8, reason: "x", flags: [], details: {} };

  it("refuses to let the agent set a final rejection", () => {
    const store = new DecisionStore(join(tmp(), "d.json"));
    expect(() => store.recordAgentDecision({ ...entry, status: "rejected" })).toThrow(/not allowed/);
  });

  it("records a human approval with attribution and keeps history", () => {
    const store = new DecisionStore(join(tmp(), "d.json"));
    store.recordAgentDecision({ ...entry, status: "rejection_pending_approval" });
    const r = store.recordHumanDecision("B", "rejected", "Jane", "Agree: no relevant experience");
    expect(r.status).toBe("rejected");
    expect(r.history.map((h) => [h.status, h.by])).toEqual([
      ["rejection_pending_approval", "agent"],
      ["rejected", "human:Jane"],
    ]);
  });
});

describe("audit log", () => {
  it("continues the hash chain across runs and detects tampering", () => {
    const file = join(tmp(), "audit.jsonl");
    new AuditLog(file, "run_1").write("decision_final", { status: "rejection_pending_approval" }, "B");
    new AuditLog(file, "run_2").write("human_decision", { to: "rejected" }, "B");
    expect(verifyAuditFile(file)).toEqual({ ok: true, count: 2 });

    writeFileSync(file, readFileSync(file, "utf8").replace("rejection_pending_approval", "advanced_to_interview"));
    expect(verifyAuditFile(file)).toMatchObject({ ok: false, line: 1 });
  });
});
