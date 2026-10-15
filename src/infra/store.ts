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
  | "advanced_to_interview"
  | "more_info_requested"
  | "rejection_pending_approval"
  | "needs_human_review"
  | "rejected";

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
  private records: Record<string, ApplicationRecord>;

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.records = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  }

  get(id: string): ApplicationRecord | undefined {
    return this.records[id];
  }

  all(): ApplicationRecord[] {
    return Object.values(this.records);
  }

  /** Used by the agent's tool implementations. Refuses any status the agent may not set. */
  recordAgentDecision(entry: Omit<ApplicationRecord, "updated_at" | "history">): ApplicationRecord {
    if (!AGENT_STATUSES.has(entry.status)) {
      throw new Error(`The agent is not allowed to set status "${entry.status}".`);
    }
    return this.put(entry, "agent", entry.reason);
  }

  /** Used only by the human review CLI. */
  recordHumanDecision(id: string, status: ApplicationStatus, reviewer: string, note: string): ApplicationRecord {
    const current = this.records[id];
    if (!current) throw new Error(`No application "${id}".`);
    return this.put({ ...current, status }, `human:${reviewer}`, note);
  }

  private put(
    entry: Omit<ApplicationRecord, "updated_at" | "history">,
    by: string,
    note: string,
  ): ApplicationRecord {
    const at = new Date().toISOString();
    const previous = this.records[entry.application_id]?.history ?? [];
    const record: ApplicationRecord = {
      ...entry,
      updated_at: at,
      history: [...previous, { at, status: entry.status, by, note }],
    };
    this.records[entry.application_id] = record;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.records, null, 2) + "\n");
    renameSync(tmp, this.file);
    return record;
  }
}
