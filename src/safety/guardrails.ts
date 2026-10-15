import {
  CRITERION_KEYS,
  expectedDecision,
  scoreCeiling,
  totalScore,
  type Assessment,
  type DecisionTool,
} from "../domain/rubric.ts";
import { TOOL_INPUT_SCHEMAS, type DecisionInput } from "../agent/tools.ts";
import { relevanceProblem } from "../domain/evidence.ts";
import { scanForInjection, type InjectionScan } from "./injection.ts";

/**
 * Every tool call the model proposes passes through here before anything is
 * written. The model is treated as an untrusted proposer: if its output had
 * been steered by the application text, these checks are what stop it.
 *
 *   1. Schema      – known tool, valid shape, values within range.
 *   2. Consistency – not_stated/ruled_out criteria carry 0 points.
 *   3. Grounding   – every evidenced or ruled_out criterion cites an exact excerpt of
 *                    the application, and that excerpt is not itself instruction-like text.
 *      Relevance   – the excerpt states the fact being scored (a duration that fits the
 *                    experience band, a language name, a tool or volume, availability).
 *   4. Arithmetic  – the score is the sum of the criteria.
 *   5. Policy      – the chosen tool is the one the rubric thresholds dictate.
 *   6. Manipulation– a flagged application is never auto-advanced.
 */

export type GuardrailVerdict =
  | {
      outcome: "allow";
      tool: DecisionTool;
      input: DecisionInput;
      score: number;
      ceiling: number;
      flags: string[];
    }
  /** Fixable by the model: violations are sent back as an error tool_result. */
  | { outcome: "retry"; violations: string[] }
  /** Not the model's call to make: goes straight to a human. */
  | { outcome: "escalate"; reason: string; input: DecisionInput; score: number; flags: string[] };

export interface GuardrailContext {
  applicationText: string;
  scan: InjectionScan;
}

export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2012-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s.,;:!-]+|[\s.,;:!-]+$/g, "");
}

function isDecisionTool(name: string): name is DecisionTool {
  return Object.hasOwn(TOOL_INPUT_SCHEMAS, name);
}

export function checkToolCall(name: string, rawInput: unknown, ctx: GuardrailContext): GuardrailVerdict {
  // 1. Schema
  if (!isDecisionTool(name)) {
    return { outcome: "retry", violations: [`Unknown tool "${name}".`] };
  }
  const parsed = TOOL_INPUT_SCHEMAS[name].safeParse(rawInput);
  if (!parsed.success) {
    return {
      outcome: "retry",
      violations: parsed.error.issues.map((i) => `Invalid input at ${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const input = parsed.data as DecisionInput;
  const assessment = input.criteria as Assessment;
  const violations: string[] = [];
  const haystack = normalizeForMatch(ctx.applicationText);

  for (const key of CRITERION_KEYS) {
    const { status, points, evidence } = assessment[key];

    // 2. Consistency
    if (status !== "evidenced" && points !== 0) {
      violations.push(`${key}: status "${status}" must carry 0 points (got ${points}).`);
    }
    if (status === "not_stated" && evidence.trim() !== "") {
      violations.push(`${key}: status "not_stated" must have empty evidence.`);
    }

    // 3. Grounding: anything that moves the score or the ceiling must be quoted.
    if (status !== "not_stated" && evidence.trim() === "") {
      violations.push(`${key}: status "${status}" needs an evidence excerpt from the application.`);
    }
    if (evidence.trim() !== "") {
      const quote = normalizeForMatch(evidence);
      const words = quote.split(" ").filter((w) => /\p{L}/u.test(w)).length;
      // One word is enough only when it is the fact itself ("English", "Zendesk").
      const selfEvident =
        words === 1 &&
        points > 0 &&
        key !== "support_experience" &&
        key !== "motivation_and_attitude" &&
        relevanceProblem(key, points, evidence) === null;
      if (words < 2 && !selfEvident) {
        violations.push(`${key}: evidence "${evidence}" is too short to support anything; quote at least a phrase.`);
      } else if (!haystack.includes(quote)) {
        violations.push(`${key}: evidence "${evidence}" does not appear verbatim in the application.`);
      } else if (scanForInjection(evidence).flagged) {
        violations.push(
          `${key}: evidence "${evidence}" is instruction-like text, not a fact about the candidate; it can't be used as evidence.`,
        );
      } else {
        const problem = relevanceProblem(key, points, evidence);
        if (problem) violations.push(`${key}: ${problem} Quote given: "${evidence}".`);
      }
    }
  }

  // 4. Arithmetic
  const score = totalScore(assessment);
  if (input.score !== score) {
    violations.push(`score is ${input.score} but the criteria points sum to ${score}.`);
  }

  // 5. Policy (only meaningful once the numbers are trustworthy)
  const ceiling = scoreCeiling(assessment);
  if (violations.length === 0) {
    const expected = expectedDecision(score, ceiling);
    if (expected !== name) {
      violations.push(
        `Policy requires ${expected} for score ${score} (ceiling ${ceiling} if all not_stated criteria scored full marks), not ${name}.`,
      );
    }
  }

  if (violations.length > 0) return { outcome: "retry", violations };

  // 6. Manipulation
  const flags: string[] = [];
  if (ctx.scan.flagged) flags.push("injection_scanner_hit");
  if (input.suspected_manipulation) flags.push("model_reported_manipulation");

  if (name === "advance_to_interview" && flags.length > 0) {
    return {
      outcome: "escalate",
      reason: "Application contains suspected manipulation; auto-advance is disabled for flagged applications.",
      input,
      score,
      flags,
    };
  }

  return { outcome: "allow", tool: name, input, score, ceiling, flags };
}
