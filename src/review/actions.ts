import type { AuditLog } from "../infra/audit.ts";
import type { ApplicationRecord, ApplicationStatus, DecisionStore } from "../infra/store.ts";

/**
 * The human side of the loop. This is the only code that can make a rejection
 * final, and every action is attributed to a named reviewer and audited.
 */

export class ReviewError extends Error {}

export const WAITING_STATUSES: readonly ApplicationStatus[] = ["rejection_pending_approval", "needs_human_review"];
export const OVERRIDE_TARGETS: readonly ApplicationStatus[] = [
  "advanced_to_interview",
  "more_info_requested",
  "rejected",
];

export function waitingForReview(store: DecisionStore): ApplicationRecord[] {
  return store.all().filter((r) => WAITING_STATUSES.includes(r.status));
}

function requireRecord(store: DecisionStore, id: string): ApplicationRecord {
  const record = store.get(id);
  if (!record) throw new ReviewError(`No application "${id}".`);
  return record;
}

function requireReviewer(reviewer: string | undefined): string {
  const name = reviewer?.trim();
  if (!name) throw new ReviewError("A reviewer name is required: every human decision is attributed.");
  return name;
}

export function approveRejection(
  store: DecisionStore,
  audit: AuditLog,
  id: string,
  reviewer: string | undefined,
  note = "",
): ApplicationRecord {
  const record = requireRecord(store, id);
  const name = requireReviewer(reviewer);
  if (record.status !== "rejection_pending_approval") {
    throw new ReviewError(`Only a pending rejection can be approved; ${id} is "${record.status}". Use override.`);
  }
  const updated = store.recordHumanDecision(id, "rejected", name, note || "Rejection approved");
  audit.write("human_decision", { from: record.status, to: "rejected", reviewer: name, note }, id);
  return updated;
}

export function overrideDecision(
  store: DecisionStore,
  audit: AuditLog,
  id: string,
  to: string | undefined,
  reviewer: string | undefined,
  note = "",
): ApplicationRecord {
  const record = requireRecord(store, id);
  const name = requireReviewer(reviewer);
  const target = OVERRIDE_TARGETS.find((s) => s === to);
  if (!target) throw new ReviewError(`--to must be one of: ${OVERRIDE_TARGETS.join(", ")}`);
  if (!note.trim()) throw new ReviewError("A note is required when overriding the agent.");
  const updated = store.recordHumanDecision(id, target, name, note);
  audit.write("human_decision", { from: record.status, to: target, reviewer: name, note }, id);
  return updated;
}
