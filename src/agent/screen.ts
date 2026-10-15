import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import type { Application } from "../domain/applications.ts";
import type { DecisionTool } from "../domain/rubric.ts";
import type { AuditLog } from "../infra/audit.ts";
import { FatalLlmError } from "../infra/errors.ts";
import type { Llm } from "../infra/llm.ts";
import type { ApplicationRecord, ApplicationStatus, DecisionStore } from "../infra/store.ts";
import { checkToolCall, type GuardrailVerdict } from "../safety/guardrails.ts";
import { scanForInjection } from "../safety/injection.ts";
import { wrapApplication } from "./prompt.ts";

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
 * Errors that mean the run can't continue (bad key, unknown model, malformed
 * request, exhausted quota). Escalating every remaining application to a human
 * wouldn't help, so these abort the run instead.
 */
function isFatal(err: unknown): boolean {
  return (
    err instanceof FatalLlmError ||
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof Anthropic.NotFoundError ||
    err instanceof Anthropic.BadRequestError
  );
}

export async function screenApplication(app: Application, deps: ScreeningDeps): Promise<ApplicationRecord> {
  const { audit, store } = deps;
  const log = (event: string, data: Record<string, unknown>) => audit.write(event, data, app.id);

  log("application_received", {
    text: app.text,
    sha256: createHash("sha256").update(app.text).digest("hex"),
  });

  // A human's decision is final. Re-running the agent must not overwrite it.
  const existing = store.get(app.id);
  if (existing && store.isHumanDecided(app.id)) {
    log("skipped_human_decided", { status: existing.status, by: existing.history.at(-1)?.by });
    return existing;
  }

  const scan = scanForInjection(app.text);
  log("injection_scan", { ...scan });

  // Remembered across turns so an escalation still carries the model's own flag.
  let modelFlagged = false;
  const currentFlags = () => [
    ...(scan.flagged ? ["injection_scanner_hit"] : []),
    ...(modelFlagged ? ["model_reported_manipulation"] : []),
  ];

  const finish = (record: ApplicationRecord) => {
    log("decision_final", { status: record.status, score: record.score, reason: record.reason, flags: record.flags });
    return record;
  };

  const escalate = (reason: string, extra: { score?: number; details?: Record<string, unknown> } = {}) => {
    const record = store.recordAgentDecision({
      application_id: app.id,
      run_id: audit.runId,
      status: "needs_human_review",
      score: extra.score ?? null,
      reason,
      flags: currentFlags(),
      details: extra.details ?? {},
    });
    log("escalated_to_human", { reason, status: record.status });
    return finish(record);
  };

  const execute = (verdict: Extract<GuardrailVerdict, { outcome: "allow" }>) => {
    const { input } = verdict;
    const record = store.recordAgentDecision({
      application_id: app.id,
      run_id: audit.runId,
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
  let lastRejected: { tool: string; violations: string[] } | undefined;

  /** Answers the model's turn with an error it can act on, so the next turn can correct it. */
  const sendFeedback = (turn: number, message: string, calls: Anthropic.Beta.BetaToolUseBlock[]) => {
    log("feedback_sent_to_model", { turn, message });
    messages.push({
      role: "user",
      content: calls.length
        ? calls.map((c): Anthropic.Beta.BetaToolResultBlockParam => ({
            type: "tool_result",
            tool_use_id: c.id,
            is_error: true,
            content: message,
          }))
        : message,
    });
  };

  for (let turn = 1; turn <= MAX_MODEL_TURNS; turn++) {
    log("model_request", { turn, message_count: messages.length });

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await deps.llm(messages);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log("model_error", { turn, error });
      // Record this application before a fatal error aborts the run, so
      // nothing is left half-screened and invisible to reviewers.
      const record = escalate("Model call failed; needs manual screening.");
      if (isFatal(err)) throw err;
      return record;
    }

    log("model_response", describeResponse(turn, response));

    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
      return escalate(`Model stopped with "${response.stop_reason}"; needs manual screening.`);
    }

    // Append-only transcript: the assistant turn goes back exactly as received.
    messages.push({ role: "assistant", content: response.content });

    const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    for (const call of calls) {
      log("tool_call_proposed", { turn, tool_use_id: call.id, tool: call.name, input: call.input });
      if ((call.input as { suspected_manipulation?: unknown })?.suspected_manipulation === true) modelFlagged = true;
    }

    if (calls.length !== 1) {
      // No call, or several at once (Claude is limited to one; Gemini isn't). Either
      // way nothing is executed: one application gets exactly one decision.
      const message =
        calls.length === 0
          ? "No decision was recorded. Call exactly one of advance_to_interview, request_more_info or reject."
          : "Decision NOT recorded: make exactly one tool call per turn. None of these calls were executed.";
      sendFeedback(turn, message, calls);
      continue;
    }

    const call = calls[0]!;
    const verdict = checkToolCall(call.name, call.input, { applicationText: app.text, scan });

    if (verdict.outcome === "retry") {
      log("guardrail_blocked", { turn, tool: call.name, violations: verdict.violations });
      lastRejected = { tool: call.name, violations: verdict.violations };
      sendFeedback(turn, `Decision NOT recorded:\n- ${verdict.violations.join("\n- ")}`, calls);
      continue;
    }

    if (verdict.outcome === "escalate") {
      log("guardrail_escalated", { turn, tool: call.name, reason: verdict.reason, flags: verdict.flags });
      return escalate(verdict.reason, {
        score: verdict.score,
        details: { proposed_tool: call.name, proposed_reason: verdict.input.reason, criteria: verdict.input.criteria },
      });
    }

    log("guardrail_passed", {
      turn,
      tool: verdict.tool,
      score: verdict.score,
      ceiling: verdict.ceiling,
      flags: verdict.flags,
    });
    return finish(execute(verdict));
  }

  return escalate(`No valid decision after ${MAX_MODEL_TURNS} model turns.`, {
    details: lastRejected ? { last_rejected_call: lastRejected } : {},
  });
}

function describeResponse(turn: number, response: Anthropic.Beta.BetaMessage) {
  const textOf = <T extends Anthropic.Beta.BetaContentBlock>(type: T["type"], pick: (b: T) => string) =>
    response.content
      .filter((b): b is T => b.type === type)
      .map(pick)
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
    thinking_summary: textOf<Anthropic.Beta.BetaThinkingBlock>("thinking", (b) => b.thinking),
    text: textOf<Anthropic.Beta.BetaTextBlock>("text", (b) => b.text),
    tool_calls: response.content.flatMap((b) => (b.type === "tool_use" ? [b.name] : [])),
  };
}
