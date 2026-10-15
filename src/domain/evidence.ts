import type { CriterionKey } from "./rubric.ts";

/**
 * What a quote has to contain before it can earn points for a criterion.
 *
 * Grounding alone ("the quote appears in the application") only proves the
 * model copied something. These rules check that the quote states the fact
 * being scored: a duration for experience, a language name for languages, and
 * so on. That way a fooled model can't support "tools: 20" with "chat support",
 * or 35 experience points with "1 year".
 */

// prettier-ignore
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

const DURATION =
  /\b(\d+(?:[.,]\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*\+?\s*(years?|yrs?|months?|mos?)\b/gi;

/** Longest duration stated in the text, in years. Null when none is stated. */
export function statedYears(text: string): number | null {
  let best: number | null = null;
  for (const [, amount = "", unit = ""] of text.matchAll(DURATION)) {
    const n = NUMBER_WORDS[amount.toLowerCase()] ?? Number(amount.replace(",", "."));
    const years = /^m/i.test(unit) ? n / 12 : n;
    if (Number.isFinite(years)) best = Math.max(best ?? 0, years);
  }
  return best;
}

/** Minimum stated years of experience for a given number of support_experience points (see the rubric anchors). */
export function yearsRequiredFor(points: number): number | null {
  if (points >= 28) return 3;
  if (points >= 20) return 1;
  if (points >= 11) return 0; // some stated duration, however short
  return null; // 1-10 covers non-support customer-facing work; no duration needed
}

const LANGUAGES =
  /\b(english|spanish|french|german|italian|portuguese|dutch|polish|russian|ukrainian|arabic|hindi|urdu|bengali|punjabi|mandarin|chinese|cantonese|japanese|korean|turkish|greek|albanian|romanian|swedish|norwegian|danish|finnish|hebrew|persian|farsi|vietnamese|thai|indonesian|malay|tagalog|filipino|swahili|czech|slovak|hungarian|serbian|croatian|bulgarian|catalan|basque|tamil|telugu)\b/i;

const VOLUME_OR_TOOLS =
  /\d|\b(zendesk|freshdesk|freshcaller|intercom|salesforce|service cloud|hubspot|jira|help ?scout|gorgias|kustomer|gladly|livechat|five9|genesys|talkdesk|aircall|crm|ticketing|csat|nps|aht|sla|slas|fcr|kpis?)\b/i;

const AVAILABILITY =
  /\b(full[- ]?time|part[- ]?time|available|availability|start|notice|immediately|asap|shifts?|weekends?|remote|on[- ]?site)\b/i;

/** Returns a reason the quote can't carry `points` for `key`, or null if it can. */
export function relevanceProblem(key: CriterionKey, points: number, evidence: string): string | null {
  if (points === 0) return null;
  switch (key) {
    case "support_experience": {
      const required = yearsRequiredFor(points);
      if (required === null) return null;
      const years = statedYears(evidence);
      if (years === null) return `${points} points needs the quote to state how long (e.g. "2 years").`;
      if (years < required) {
        return `${points} points needs ${required}+ years of support; the quote states ${+years.toFixed(2)}.`;
      }
      return null;
    }
    case "volume_and_tools":
      return VOLUME_OR_TOOLS.test(evidence) ? null : "the quote must state a volume, a metric or a named tool.";
    case "languages":
      return LANGUAGES.test(evidence) ? null : "the quote must name a language.";
    case "availability":
      return AVAILABILITY.test(evidence) ? null : "the quote must state availability (full-time, start date, notice).";
    case "motivation_and_attitude":
      return null; // a judgment call; the quote still has to exist and be a phrase
  }
}
