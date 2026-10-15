import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Application status store (a JSON file standing in for a database).
 *
 * The agent can only ever produce the first four statuses. `rejected` exists
 * solely as the result of a human approving a pending rejection — there is no
 * code path from the agent to it.
 */
export type ApplicationStatus =
  "advanced_to_interview" | "more_info_requested" | "rejection_pending_approval" | "needs_human_review" | "rejected";

export const AGENT_STATUSES: ReadonlySet<ApplicationStatus> = new Set([
  "advanced_to_interview",
  "more_info_requested",
  "rejection_pending_approval",
  "needs_human_review",
]);

export interface HistoryEntry {
  at: string;
  status: ApplicationStatus;
  by: string;
  note: string;
}

export interface ApplicationRecord {
  application_id: string;
  run_id: string;
  status: ApplicationStatus;
  score: number | null;
  reason: string;
  flags: string[];
  details: Record<string, unknown>;
  updated_at: string;
  history: HistoryEntry[];
}

export class DecisionStore {
  // A Map, not a plain object, so an id like "__proto__" is just a key.
  private records = new Map<string, ApplicationRecord>();

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.reload();
  }

  /** Re-reads the file so a write never clobbers a decision made by another process (e.g. the review CLI). */
  private reload(): void {
    const parsed = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as object) : {};
    this.records = new Map(Object.entries(parsed));
  }

  get(id: string): ApplicationRecord | undefined {
    return this.records.get(id);
  }

  all(): ApplicationRecord[] {
    return [...this.records.values()];
  }

  /** True once a person has made a decision on this application. */
  isHumanDecided(id: string): boolean {
    return this.records.get(id)?.history.some((h) => h.by.startsWith("human:")) ?? false;
  }

  /** Used by the agent's tool implementations. Refuses any status the agent may not set. */
  recordAgentDecision(entry: Omit<ApplicationRecord, "updated_at" | "history">): ApplicationRecord {
    this.reload();
    if (!AGENT_STATUSES.has(entry.status)) {
      throw new Error(`The agent is not allowed to set status "${entry.status}".`);
    }
    if (this.isHumanDecided(entry.application_id)) {
      throw new Error(`Application "${entry.application_id}" has a human decision; the agent can't overwrite it.`);
    }
    return this.put(entry, "agent", entry.reason);
  }

  /** Used only by the human review CLI. */
  recordHumanDecision(id: string, status: ApplicationStatus, reviewer: string, note: string): ApplicationRecord {
    this.reload();
    const current = this.records.get(id);
    if (!current) throw new Error(`No application "${id}".`);
    return this.put({ ...current, status }, `human:${reviewer}`, note);
  }

  private put(entry: Omit<ApplicationRecord, "updated_at" | "history">, by: string, note: string): ApplicationRecord {
    const at = new Date().toISOString();
    const previous = this.records.get(entry.application_id)?.history ?? [];
    const record: ApplicationRecord = {
      ...entry,
      updated_at: at,
      history: [...previous, { at, status: entry.status, by, note }],
    };
    this.records.set(entry.application_id, record);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.records), null, 2) + "\n");
    renameSync(tmp, this.file);
    return record;
  }
}
