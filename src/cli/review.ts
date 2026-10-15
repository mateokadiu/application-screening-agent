import { join } from "node:path";
import { parseArgs } from "node:util";
import { AuditLog } from "../infra/audit.ts";
import { consoleReporter } from "../infra/reporter.ts";
import { DecisionStore } from "../infra/store.ts";
import { approveRejection, overrideDecision, ReviewError, waitingForReview } from "../review/actions.ts";

/**
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

const [command = "list", id = ""] = positionals;
const store = new DecisionStore(join(values.out, "decisions.json"));

function audit(): AuditLog {
  const log = new AuditLog(join(values.out, "audit.jsonl"), `review_${Date.now()}`);
  log.onRecord(consoleReporter(join(values.out, "transcript.log")));
  return log;
}

try {
  switch (command) {
    case "list": {
      const waiting = waitingForReview(store);
      if (waiting.length === 0) console.log("Nothing waiting for human review.");
      for (const r of waiting) {
        console.log(`${r.application_id.padEnd(6)} ${r.status.padEnd(28)} score=${r.score ?? "—"}  ${r.reason}`);
        if (r.flags.length) console.log(`       flags: ${r.flags.join(", ")}`);
      }
      break;
    }
    case "show": {
      const record = store.get(id);
      if (!record) throw new ReviewError(`No application "${id}".`);
      console.log(JSON.stringify(record, null, 2));
      break;
    }
    case "approve":
      approveRejection(store, audit(), id, values.reviewer, values.note);
      break;
    case "override":
      overrideDecision(store, audit(), id, values.to, values.reviewer, values.note);
      break;
    default:
      throw new ReviewError(`Unknown command "${command}". Use list | show | approve | override.`);
  }
} catch (err) {
  if (!(err instanceof ReviewError)) throw err;
  console.error(err.message);
  process.exit(1);
}
