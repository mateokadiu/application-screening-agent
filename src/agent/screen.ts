import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import type { DecisionTool } from "../domain/rubric.ts";
import type { AuditLog } from "../infra/audit.ts";
import type { Llm } from "../infra/llm.ts";
import type { ApplicationRecord, ApplicationStatus, DecisionStore } from "../infra/store.ts";
import { checkToolCall, type GuardrailVerdict } from "../safety/guardrails.ts";
import { scanForInjection } from "../safety/injection.ts";
import { wrapApplication } from "./prompt.ts";

export interface Application {
  id: string;
  text: string;
}

export interface ScreeningDeps {
  llm: Llm;
  audit: AuditLog;
  store: DecisionStore;
}

/** Model turns per application: the first attempt plus room for two corrections. */
export const MAX_MODEL_TURNS = 3;

const STATUS_BY_TOOL: Record<DecisionTool, ApplicationStatus> = {
  advance_to_interview: "advanced_to_interview",
  request_more_info: "more_info_requested",
  // The agent's "reject" never rejects anyone. It files a recommendation.
  reject: "rejection_pending_approval",
};

/**
 * Errors that mean the run itself is misconfigured (bad key, unknown model,
 * malformed request). Escalating every application to a human wouldn't help,
 * so these abort the run instead.
 */
function isConfigurationError(err: unknown): boolean {
  return (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof Anthropic.NotFoundError ||
    err instanceof Anthropic.BadRequestError
  );
}

export async function screenApplication(app: Application, deps: ScreeningDeps): Promise<ApplicationRecord> {
  const { audit, store } = deps;
  const runId = audit.runId;
  const log = (event: string, data: Record<string, unknown>) => audit.write(event, data, app.id);

  log("application_received", {
    text: app.text,
    sha256: createHash("sha256").update(app.text).digest("hex"),
  });

  const scan = scanForInjection(app.text);
  log("injection_scan", { ...scan });

  const escalate = (reason: string, extra: { score?: number; flags?: string[]; details?: Record<string, unknown> } = {}) => {
    const record = store.recordAgentDecision({
      application_id: app.id,
      run_id: runId,
      status: "needs_human_review",
      score: extra.score ?? null,
      reason,
      flags: extra.flags ?? (scan.flagged ? ["injection_scanner_hit"] : []),
      details: extra.details ?? {},
    });
    log("escalated_to_human", { reason, status: record.status });
    log("decision_final", summarize(record));
    return record;
  };

  const execute = (verdict: Extract<GuardrailVerdict, { outcome: "allow" }>) => {
    const { input } = verdict;
    const record = store.recordAgentDecision({
      application_id: app.id,
      run_id: runId,
      status: STATUS_BY_TOOL[verdict.tool],
      score: verdict.score,
      reason: input.reason,
      flags: verdict.flags,
      details: {
        ceiling: verdict.ceiling,
        criteria: input.criteria,
        ...(input.questions && { questions_for_candidate: input.questions }),
        ...(input.interview_focus && { interview_focus: input.interview_focus }),
        ...(input.manipulation_excerpt && { manipulation_excerpt: input.manipulation_excerpt }),
      },
    });
    log("tool_executed", { tool: verdict.tool, status: record.status });
    return record;
  };

  const { content, boundary } = wrapApplication(app.text);
  log("prompt_built", { boundary });
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content }];

  for (let turn = 1; turn <= MAX_MODEL_TURNS; turn++) {
    log("model_request", { turn, message_count: messages.length });

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await deps.llm(messages);
    } catch (err) {
      if (isConfigurationError(err)) throw err;
      log("model_error", { turn, error: err instanceof Error ? err.message : String(err) });
      return escalate("Model call failed; needs manual screening.");
    }

    log("model_response", describeResponse(turn, response));

    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
      return escalate(`Model stopped with "${response.stop_reason}"; needs manual screening.`);
    }

    // Append-only transcript: the assistant turn goes back exactly as received.
    messages.push({ role: "assistant", content: response.content });

    const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (calls.length === 0) {
      const nudge =
        "No decision was recorded. Call exactly one of advance_to_interview, request_more_info or reject.";
      log("nudge_sent", { turn, message: nudge });
      messages.push({ role: "user", content: nudge });
      continue;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    let decided: ApplicationRecord | undefined;

    for (const call of calls) {
      log("tool_call_proposed", { turn, tool_use_id: call.id, tool: call.name, input: call.input });

      if (decided) {
        results.push(toolError(call.id, "A decision has already been recorded for this application."));
        continue;
      }

      const verdict = checkToolCall(call.name, call.input, { applicationText: app.text, scan });

      if (verdict.outcome === "retry") {
        log("guardrail_blocked", { turn, tool: call.name, violations: verdict.violations });
        results.push(toolError(call.id, `Decision NOT recorded:\n- ${verdict.violations.join("\n- ")}`));
        continue;
      }

      if (verdict.outcome === "escalate") {
        log("guardrail_escalated", { turn, tool: call.name, reason: verdict.reason, flags: verdict.flags });
        decided = escalate(verdict.reason, {
          score: verdict.score,
          flags: verdict.flags,
          details: { proposed_tool: call.name, proposed_reason: verdict.input.reason, criteria: verdict.input.criteria },
        });
        results.push(toolError(call.id, "Not executed: routed to a human reviewer."));
        continue;
      }

      log("guardrail_passed", { turn, tool: verdict.tool, score: verdict.score, ceiling: verdict.ceiling, flags: verdict.flags });
      decided = execute(verdict);
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify({ recorded: true, status: decided.status }),
      });
    }

    for (const r of results) log("tool_result_returned", { ...r });
    messages.push({ role: "user", content: results });

    if (decided) {
      if (decided.status !== "needs_human_review") log("decision_final", summarize(decided));
      return decided;
    }
  }

  return escalate(`No valid decision after ${MAX_MODEL_TURNS} model turns.`);
}

function toolError(toolUseId: string, message: string): Anthropic.Beta.BetaToolResultBlockParam {
  return { type: "tool_result", tool_use_id: toolUseId, is_error: true, content: message };
}

function summarize(record: ApplicationRecord) {
  return { status: record.status, score: record.score, reason: record.reason, flags: record.flags };
}

function describeResponse(turn: number, response: Anthropic.Beta.BetaMessage) {
  const thinking = response.content
    .filter((b): b is Anthropic.Beta.BetaThinkingBlock => b.type === "thinking")
    .map((b) => b.thinking)
    .join("\n")
    .trim();
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return {
    turn,
    id: response.id,
    model: response.model,
    stop_reason: response.stop_reason,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
    },
    thinking_summary: thinking,
    text,
    tool_calls: response.content.filter((b) => b.type === "tool_use").map((b) => (b as Anthropic.Beta.BetaToolUseBlock).name),
  };
}
