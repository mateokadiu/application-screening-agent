import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { screenApplication } from "../agent/screen.ts";
import { PROMPT_SHA256 } from "../agent/prompt.ts";
import { DECISION_TOOL_NAMES } from "../agent/tools.ts";
import { loadApplications } from "../domain/applications.ts";
import { RUBRIC_VERSION } from "../domain/rubric.ts";
import { AuditLog } from "../infra/audit.ts";
import { API_KEY_VAR, createLlm, loadLlmConfig } from "../infra/llm.ts";
import { consoleReporter } from "../infra/reporter.ts";
import { DecisionStore } from "../infra/store.ts";
import { renderSummary, type SummaryRow } from "../infra/summary.ts";

const { values } = parseArgs({
  options: {
    file: { type: "string", default: "samples/applications.json" },
    out: { type: "string", default: "output" },
  },
});

const config = loadLlmConfig();
const keyVar = API_KEY_VAR[config.provider];
if (!process.env[keyVar]) {
  console.error(`Missing ${keyVar} for provider "${config.provider}". Copy .env.example to .env and add your key.`);
  process.exit(1);
}
const runId = `run_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}_${randomBytes(3).toString("hex")}`;
const auditFile = join(values.out, "audit.jsonl");
const storeFile = join(values.out, "decisions.json");

const audit = new AuditLog(auditFile, runId);
audit.onRecord(consoleReporter(join(values.out, "transcript.log")));
const store = new DecisionStore(storeFile);
const llm = createLlm(config);

const applications = loadApplications(values.file);
audit.write("run_started", {
  provider: config.provider,
  model: config.model,
  effort: config.effort,
  rubric_version: RUBRIC_VERSION,
  prompt_sha256: PROMPT_SHA256,
  tools: DECISION_TOOL_NAMES,
  source: values.file,
  application_ids: applications.map((a) => a.id),
});

const servedBy = new Set<string>();
audit.onRecord((r) => {
  if (r.event === "model_response") servedBy.add(String(r.data.model));
});

const results: SummaryRow[] = [];
const writeSummary = (aborted?: string) =>
  writeFileSync(
    join(values.out, "summary.md"),
    renderSummary({
      runId,
      requestedModel: config.model,
      servedBy: [...servedBy],
      rubricVersion: RUBRIC_VERSION,
      promptSha256: PROMPT_SHA256,
      rows: results,
      aborted,
    }),
  );

try {
  for (const app of applications) {
    const record = await screenApplication(app, { llm, audit, store });
    const { status, score, flags, reason } = record;
    results.push({ application_id: app.id, status, score, flags, reason });
  }
} catch (err) {
  // Fatal model errors (bad key, unknown model, used-up quota) stop the run; nothing further is decided.
  const message = err instanceof Error ? err.message : String(err);
  audit.write("run_aborted", { error: message, completed: results.length });
  writeSummary(message);
  console.error(`\nRun aborted: ${message}`);
  process.exit(1);
}

audit.write("run_completed", { results, audit_file: auditFile, store_file: storeFile });
writeSummary();
