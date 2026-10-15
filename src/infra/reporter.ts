import { appendFileSync } from "node:fs";
import type { AuditListener, AuditRecord } from "./audit.ts";

/**
 * Human-readable view of the audit stream. Prints to the console and mirrors
 * the same lines (without colours) into a transcript file.
 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: paint(2), bold: paint(1), red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36), magenta: paint(35) };

const indent = (s: string, pad = "      ") => s.split("\n").map((l) => pad + l).join("\n");

function format(r: AuditRecord): string | null {
  const d = r.data as Record<string, any>;
  switch (r.event) {
    case "run_started":
      return c.bold(`\nScreening run ${r.run_id}`) + c.dim(`\n  model=${d.model} effort=${d.effort} rubric=${d.rubric_version} prompt_sha256=${String(d.prompt_sha256).slice(0, 12)}…`);
    case "application_received":
      return `\n${c.bold(c.cyan(`━━ Application ${r.application_id} ━━`))}\n${indent(`"${d.text}"`, "  ")}`;
    case "injection_scan":
      return d.flagged
        ? c.yellow(`  ⚠ injection scanner: ${d.matches.length} hit(s) [${[...new Set(d.matches.map((m: any) => m.rule))].join(", ")}]\n${indent(`"${d.matches[0].excerpt}"`)}`)
        : c.dim("  ✓ injection scanner: clean");
    case "model_request":
      return c.dim(`  → model turn ${d.turn}`);
    case "model_response": {
      const lines = [c.dim(`  ← ${d.model} stop=${d.stop_reason} in=${d.usage.input_tokens} out=${d.usage.output_tokens} cache_read=${d.usage.cache_read_input_tokens}`)];
      if (d.thinking_summary) lines.push(c.dim(indent(`reasoning summary: ${d.thinking_summary}`)));
      if (d.text) lines.push(indent(`text: ${d.text}`));
      return lines.join("\n");
    }
    case "nudge_sent":
      return c.yellow(`  ↻ no tool call — nudging the model`);
    case "tool_call_proposed": {
      const i = d.input as Record<string, any>;
      const crit = i?.criteria
        ? Object.entries(i.criteria as Record<string, any>)
            .map(([k, v]) => `${k.padEnd(29)} ${String(v.points).padStart(2)}  ${v.status.padEnd(10)} ${v.evidence ? `"${v.evidence}"` : ""}`)
            .join("\n")
        : JSON.stringify(i);
      const extras = [
        i?.questions && `questions: ${JSON.stringify(i.questions)}`,
        i?.interview_focus && `interview_focus: ${JSON.stringify(i.interview_focus)}`,
        i?.suspected_manipulation && `suspected_manipulation: "${i.manipulation_excerpt}"`,
      ].filter(Boolean);
      return [
        c.magenta(`  ⚙ tool call: ${d.tool}(score=${i?.score})`),
        indent(`reason: ${i?.reason}`),
        indent(crit),
        ...extras.map((e) => indent(e as string)),
      ].join("\n");
    }
    case "guardrail_blocked":
      return c.red(`  ✗ guardrails blocked ${d.tool}:\n${indent(d.violations.map((v: string) => `- ${v}`).join("\n"))}`);
    case "guardrail_escalated":
      return c.yellow(`  ⏸ guardrails escalated ${d.tool}: ${d.reason}`);
    case "guardrail_passed":
      return c.green(`  ✓ guardrails passed (score=${d.score}, ceiling=${d.ceiling}${d.flags.length ? `, flags=${d.flags.join(",")}` : ""})`);
    case "tool_executed":
      return c.green(`  ✔ executed ${d.tool} → status "${d.status}"`);
    case "tool_result_returned":
      return c.dim(`  ↩ tool_result${d.is_error ? " (error)" : ""}: ${String(d.content).replace(/\n/g, " ")}`);
    case "model_error":
      return c.red(`  ✗ model error: ${d.error}`);
    case "escalated_to_human":
      return c.yellow(`  ⏸ escalated to human review: ${d.reason}`);
    case "decision_final": {
      const color = d.status === "advanced_to_interview" ? c.green : d.status === "more_info_requested" ? c.cyan : c.yellow;
      return color(c.bold(`  ▶ ${r.application_id}: ${d.status}  score=${d.score ?? "—"}${d.flags.length ? `  flags=${d.flags.join(",")}` : ""}\n    ${d.reason}`));
    }
    case "run_completed": {
      const rows = (d.results as any[]).map(
        (x) => `  ${x.application_id.padEnd(6)} ${String(x.score ?? "—").padStart(3)}  ${x.status.padEnd(28)} ${x.flags.join(",")}`,
      );
      return [c.bold("\nSummary"), `  ${"app".padEnd(6)} ${"scr".padStart(3)}  ${"status".padEnd(28)} flags`, ...rows, c.dim(`\n  audit log: ${d.audit_file}\n  decisions: ${d.store_file}`)].join("\n");
    }
    case "human_decision":
      return c.bold(`  ${r.application_id}: ${d.from} → ${d.to} by ${d.reviewer}${d.note ? ` (${d.note})` : ""}`);
    default:
      return null;
  }
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

export function consoleReporter(transcriptFile?: string): AuditListener {
  return (record) => {
    const line = format(record);
    if (line === null) return;
    console.log(line);
    if (transcriptFile) appendFileSync(transcriptFile, stripAnsi(line) + "\n");
  };
}
