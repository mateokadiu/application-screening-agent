import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, verifyAuditFile } from "../src/infra/audit.ts";
import { DecisionStore, type ApplicationStatus } from "../src/infra/store.ts";
import { approveRejection, overrideDecision, waitingForReview } from "../src/review/actions.ts";

function setup(status: ApplicationStatus) {
  const dir = mkdtempSync(join(tmpdir(), "screening-review-"));
  const store = new DecisionStore(join(dir, "decisions.json"));
  store.recordAgentDecision({
    application_id: "B",
    run_id: "r",
    status,
    score: 6,
    reason: "x",
    flags: [],
    details: {},
  });
  return { dir, store, audit: new AuditLog(join(dir, "audit.jsonl"), "review_test") };
}

describe("human review", () => {
  it("lists what is waiting and approves a pending rejection, attributed and audited", () => {
    const t = setup("rejection_pending_approval");
    expect(waitingForReview(t.store).map((r) => r.application_id)).toEqual(["B"]);

    const record = approveRejection(t.store, t.audit, "B", "Jane Doe", "Agree");
    expect(record.status).toBe("rejected");
    expect(record.history.at(-1)?.by).toBe("human:Jane Doe");
    expect(waitingForReview(t.store)).toEqual([]);
    expect(verifyAuditFile(join(t.dir, "audit.jsonl"))).toEqual({ ok: true, count: 1 });
  });

  it("refuses anonymous decisions and approving anything but a pending rejection", () => {
    const pending = setup("rejection_pending_approval");
    expect(() => approveRejection(pending.store, pending.audit, "B", "  ")).toThrow(/reviewer/);
    const t = setup("more_info_requested");
    expect(() => approveRejection(t.store, t.audit, "B", "Jane")).toThrow(/Only a pending rejection/);
    expect(() => approveRejection(t.store, t.audit, "Z", "Jane")).toThrow(/No application/);
  });

  it("overrides need a valid target and a note", () => {
    const t = setup("needs_human_review");
    expect(() => overrideDecision(t.store, t.audit, "B", "deleted", "Jane", "x")).toThrow(/--to must be/);
    expect(() => overrideDecision(t.store, t.audit, "B", "more_info_requested", "Jane", "")).toThrow(
      /note is required/,
    );
    expect(overrideDecision(t.store, t.audit, "B", "more_info_requested", "Jane", "Asked by phone").status).toBe(
      "more_info_requested",
    );
  });
});
