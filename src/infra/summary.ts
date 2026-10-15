/** One-page Markdown summary of a run, written next to the audit log. */

export interface SummaryRow {
  application_id: string;
  status: string;
  score: number | null;
  flags: string[];
  reason: string;
}

export interface SummaryInput {
  runId: string;
  requestedModel: string;
  servedBy: string[];
  rubricVersion: string;
  promptSha256: string;
  rows: SummaryRow[];
  aborted?: string;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderSummary(input: SummaryInput): string {
  const served = input.servedBy.length ? input.servedBy.join(", ") : "—";
  return [
    `# Screening run \`${input.runId}\``,
    "",
    `- Model requested: \`${input.requestedModel}\`, served by: \`${served}\``,
    `- Rubric \`${input.rubricVersion}\`, system prompt SHA-256 \`${input.promptSha256.slice(0, 12)}…\``,
    ...(input.aborted ? [`- **Run aborted:** ${cell(input.aborted)}`] : []),
    "",
    "Agent decisions (human decisions made afterwards are in `decisions.json` and the audit log):",
    "",
    "| Application | Decision | Score | Flags | Reason |",
    "| --- | --- | --- | --- | --- |",
    ...input.rows.map(
      (r) =>
        `| ${cell(r.application_id)} | ${r.status} | ${r.score ?? "—"} | ${r.flags.join(", ") || "—"} | ${cell(r.reason)} |`,
    ),
    "",
  ].join("\n");
}
