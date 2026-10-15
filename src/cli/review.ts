import { join } from "node:path";
import { parseArgs } from "node:util";
import { AuditLog } from "../infra/audit.ts";
import { consoleReporter } from "../infra/reporter.ts";
import { DecisionStore, type ApplicationStatus } from "../infra/store.ts";

/**
 * The human side of the loop. Rejections only become final here.
 *
 *   npm run review                                     list everything waiting on a human
 *   npm run review -- show B
 *   npm run review -- approve B --reviewer "Jane Doe" [--note "..."]
 *   npm run review -- override C --to more_info_requested --reviewer "Jane Doe" --note "..."
 */

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: "output" },
    reviewer: { type: "string" },
    note: { type: "string", default: "" },
    to: { type: "string" },
  },
});

const [command = "list", id] = positionals;
const store = new DecisionStore(join(values.out, "decisions.json"));
const WAITING: ApplicationStatus[] = ["rejection_pending_approval", "needs_human_review"];
const OVERRIDE_TARGETS: ApplicationStatus[] = ["advanced_to_interview", "more_info_requested", "rejected"];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function audit(): AuditLog {
  const log = new AuditLog(join(values.out, "audit.jsonl"), `review_${Date.now()}`);
  log.onRecord(consoleReporter(join(values.out, "transcript.log")));
  return log;
}

function requireRecord() {
  if (!id) fail("Missing application id.");
  return store.get(id) ?? fail(`No application "${id}".`);
}

function requireReviewer(): string {
  return values.reviewer?.trim() || fail("--reviewer is required: every human decision is attributed.");
}

switch (command) {
  case "list": {
    const waiting = store.all().filter((r) => WAITING.includes(r.status));
    if (waiting.length === 0) console.log("Nothing waiting for human review.");
    for (const r of waiting) {
      console.log(`${r.application_id.padEnd(6)} ${r.status.padEnd(28)} score=${r.score ?? "—"}  ${r.reason}`);
      if (r.flags.length) console.log(`       flags: ${r.flags.join(", ")}`);
    }
    break;
  }

  case "show":
    console.log(JSON.stringify(requireRecord(), null, 2));
    break;

  case "approve": {
    const record = requireRecord();
    const reviewer = requireReviewer();
    if (record.status !== "rejection_pending_approval") {
      fail(`Only a pending rejection can be approved; ${record.application_id} is "${record.status}". Use override.`);
    }
    store.recordHumanDecision(record.application_id, "rejected", reviewer, values.note || "Rejection approved");
    audit().write("human_decision", { from: record.status, to: "rejected", reviewer, note: values.note }, record.application_id);
    break;
  }

  case "override": {
    const record = requireRecord();
    const reviewer = requireReviewer();
    const to = values.to as ApplicationStatus;
    if (!OVERRIDE_TARGETS.includes(to)) fail(`--to must be one of: ${OVERRIDE_TARGETS.join(", ")}`);
    if (!values.note.trim()) fail("--note is required when overriding the agent.");
    store.recordHumanDecision(record.application_id, to, reviewer, values.note);
    audit().write("human_decision", { from: record.status, to, reviewer, note: values.note }, record.application_id);
    break;
  }

  default:
    fail(`Unknown command "${command}". Use list | show | approve | override.`);
}
