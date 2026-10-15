/**
 * Deterministic tripwire for instruction-like text inside an application.
 *
 * This is NOT the main defence — pattern lists are always bypassable. The real
 * protections are structural (see guardrails.ts). The scanner exists so that
 * (1) a human reviewer sees the flag even if the model doesn't, and
 * (2) a flagged application can never be auto-advanced.
 */

export interface InjectionMatch {
  rule: string;
  /** The sentence containing the hit, so reviewers see it in context. */
  excerpt: string;
  start: number;
  end: number;
}

export interface InjectionScan {
  flagged: boolean;
  matches: InjectionMatch[];
}

const RULES: Array<{ rule: string; pattern: RegExp }> = [
  {
    rule: "override_instructions",
    pattern:
      /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(instructions?|rubric|rules?|prompt|guidelines?|criteria|scoring|policy)\b/gi,
  },
  {
    rule: "fake_authority",
    pattern:
      /\b(system|admin(istrator)?|developer|operator|hr|recruiter|hiring manager)[\s-]*(note|message|prompt|override|instruction|notice|directive)s?\b/gi,
  },
  {
    rule: "addresses_the_ai",
    pattern:
      /\b(you are now|as an ai|dear (ai|assistant|model|bot|screener)|(note|message) (to|for) the (ai|assistant|model|reviewer|screener|bot)|ai (reviewer|screener|assistant))\b/gi,
  },
  {
    rule: "dictates_outcome",
    pattern:
      /\b((advance|approve|shortlist|accept|pass|hire|move)\s+(this|the|me|my)\s+(candidate|application|applicant|profile)|(score|rate|grade)\b[^.\n]{0,30}\b(100|maximum|max|perfect|full marks))\b/gi,
  },
  {
    rule: "names_internal_tools",
    pattern: /\b(advance_to_interview|request_more_info|reject\s*\(|tool_use|tool_result|function_call)\b/gi,
  },
  {
    rule: "markup_spoofing",
    pattern: /<\/?\s*(system|instructions?|application\w*|tool\w*|assistant|user|prompt)\b[^>]*>|\[\/?(INST|SYS)\]|```\s*(system|json)/gi,
  },
  {
    rule: "hidden_characters",
    // Zero-width and bidi-override characters have no place in a job application.
    pattern: /[​-‏‪-‮⁠-⁤﻿]/g,
  },
];

function sentenceAround(text: string, start: number, end: number): { start: number; end: number } {
  const before = Math.max(text.lastIndexOf(".", start - 1), text.lastIndexOf("\n", start - 1));
  const sStart = before === -1 ? 0 : before + 1;
  const after = [".", "\n"].map((c) => text.indexOf(c, end)).filter((i) => i !== -1);
  const sEnd = after.length ? Math.min(...after) + 1 : text.length;
  return { start: sStart, end: sEnd };
}

export function scanForInjection(raw: string): InjectionScan {
  // NFKC folds full-width / compatibility characters ("ｉｇｎｏｒｅ") into plain ASCII.
  // It can change string length, so offsets are only reported against the raw
  // text when normalisation is a no-op.
  const text = raw.normalize("NFKC");
  const offsetsReliable = text === raw;
  const matches: InjectionMatch[] = [];

  for (const { rule, pattern } of RULES) {
    for (const m of text.matchAll(pattern)) {
      const span = sentenceAround(text, m.index, m.index + m[0].length);
      matches.push({
        rule,
        excerpt: text.slice(span.start, span.end).trim(),
        start: offsetsReliable ? span.start : 0,
        end: offsetsReliable ? span.end : raw.length,
      });
    }
  }

  return { flagged: matches.length > 0, matches };
}
