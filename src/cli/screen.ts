import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { screenApplication } from "../agent/screen.ts";
import { PROMPT_SHA256 } from "../agent/prompt.ts";
import { DECISION_TOOL_NAMES } from "../agent/tools.ts";
import { loadApplications } from "../domain/applications.ts";
import { RUBRIC_VERSION } from "../domain/rubric.ts";
import { AuditLog } from "../infra/audit.ts";
import { createAnthropicLlm, loadLlmConfig } from "../infra/llm.ts";
import { consoleReporter } from "../infra/reporter.ts";
import { DecisionStore } from "../infra/store.ts";

const { values } = parseArgs({
  options: {
    file: { type: "string", default: "samples/applications.json" },
    out: { type: "string", default: "output" },
  },
});

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const config = loadLlmConfig();
const runId = `run_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}_${randomBytes(3).toString("hex")}`;
const auditFile = join(values.out, "audit.jsonl");
const storeFile = join(values.out, "decisions.json");

const audit = new AuditLog(auditFile, runId);
audit.onRecord(consoleReporter(join(values.out, "transcript.log")));
const store = new DecisionStore(storeFile);
const llm = createAnthropicLlm(config);

const applications = loadApplications(values.file);
audit.write("run_started", {
  model: config.model,
  effort: config.effort,
  rubric_version: RUBRIC_VERSION,
  prompt_sha256: PROMPT_SHA256,
  tools: DECISION_TOOL_NAMES,
  source: values.file,
  application_ids: applications.map((a) => a.id),
});

const results = [];
for (const app of applications) {
  const record = await screenApplication(app, { llm, audit, store });
  results.push({ application_id: app.id, status: record.status, score: record.score, flags: record.flags });
}

audit.write("run_completed", { results, audit_file: auditFile, store_file: storeFile });
