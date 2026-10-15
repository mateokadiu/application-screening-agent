import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only JSONL audit log. Each line carries the hash of the previous
 * line, so editing or deleting a past entry breaks the chain and
 * `npm run audit:verify` will point at it.
 */

export interface AuditRecord {
  seq: number;
  ts: string;
  run_id: string;
  application_id: string | null;
  event: string;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export type AuditListener = (record: AuditRecord) => void;

const GENESIS = "0".repeat(64);

export function hashRecord(record: Omit<AuditRecord, "hash">): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

export class AuditLog {
  private seq = 0;
  private prevHash = GENESIS;
  private listeners: AuditListener[] = [];

  constructor(
    private readonly file: string,
    readonly runId: string,
  ) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
      const last = lines.at(-1);
      if (last) {
        const check = verifyAuditFile(file);
        if (!check.ok) {
          // Fail closed: appending to a broken chain would hide where it broke.
          throw new Error(`Audit log ${file} is damaged at line ${check.line} (${check.problem}); refusing to append.`);
        }
        const parsed = JSON.parse(last) as AuditRecord;
        this.seq = parsed.seq;
        this.prevHash = parsed.hash;
      }
    }
  }

  onRecord(listener: AuditListener): void {
    this.listeners.push(listener);
  }

  write(event: string, data: Record<string, unknown>, applicationId: string | null = null): AuditRecord {
    const base = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      run_id: this.runId,
      application_id: applicationId,
      event,
      data,
      prev_hash: this.prevHash,
    };
    const record: AuditRecord = { ...base, hash: hashRecord(base) };
    appendFileSync(this.file, JSON.stringify(record) + "\n");
    this.prevHash = record.hash;
    for (const l of this.listeners) l(record);
    return record;
  }
}

export function verifyAuditFile(
  file: string,
): { ok: true; count: number } | { ok: false; line: number; problem: string } {
  const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  let prev = GENESIS;
  for (const [i, line] of lines.entries()) {
    let parsed: AuditRecord;
    try {
      parsed = JSON.parse(line) as AuditRecord;
    } catch {
      return { ok: false, line: i + 1, problem: "entry is not valid JSON (partial write?)" };
    }
    const { hash, ...rest } = parsed;
    if (rest.prev_hash !== prev) return { ok: false, line: i + 1, problem: "prev_hash does not match previous entry" };
    if (hashRecord(rest) !== hash) return { ok: false, line: i + 1, problem: "entry content does not match its hash" };
    prev = hash;
  }
  return { ok: true, count: lines.length };
}
