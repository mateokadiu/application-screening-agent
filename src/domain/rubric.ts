/**
 * Scoring rubric and decision policy for the Customer Support Specialist role.
 *
 * The model judges the evidence (which criterion is met, how well, and where
 * in the application it says so). Everything after that — totals, thresholds,
 * which action is allowed — is plain code in this file, so the outcome can't
 * be talked into anything by the text being scored.
 */

export const RUBRIC_VERSION = "css-2026-10-v3";
export const ROLE = "Customer Support Specialist";

export const CRITERIA = {
  support_experience: {
    label: "Customer support experience",
    max: 35,
    anchors: [
      "0: no customer-facing experience",
      "1-10: customer-facing work that is not support (retail, hospitality, sales floor)",
      "11-19: under 1 year in a support role",
      "20-27: 1-2 years in a support role (call centre, helpdesk, chat/email support)",
      "28-35: 3+ years in a support role; top of band for high-volume or lead experience",
    ],
  },
  volume_and_tools: {
    label: "Ticket volume, metrics and helpdesk tools",
    max: 20,
    anchors: [
      "0-10: evidence of handling volume or hitting support metrics (tickets/calls per day, CSAT, AHT, SLAs)",
      "0-10: hands-on use of helpdesk/CRM tools (Zendesk, Freshdesk, Intercom, Salesforce Service Cloud, ...)",
    ],
  },
  languages: {
    label: "Languages",
    max: 15,
    anchors: [
      "0-10: fluent English (required for the role)",
      "0-5: an additional language useful for customer contact",
    ],
  },
  availability: {
    label: "Availability",
    max: 15,
    anchors: ["0-8: available full-time", "0-7: can start within 4 weeks"],
  },
  // Deliberately not "quality of writing": these applications are short summaries,
  // and grading prose penalises non-native speakers. Written communication is
  // better tested in the interview with a sample reply.
  motivation_and_attitude: {
    label: "Motivation and service attitude",
    max: 15,
    anchors: [
      "0-8: stated motivation for the role or for customer support",
      "0-7: stated service attitude, empathy or willingness to learn",
    ],
  },
} as const;

export type CriterionKey = keyof typeof CRITERIA;
export const CRITERION_KEYS = Object.keys(CRITERIA) as CriterionKey[];

/**
 * evidenced  – the application says something about this criterion.
 * ruled_out  – the applicant's own words show they don't meet it ("I have no experience").
 * not_stated – the application is silent, and the answer could plausibly be positive.
 */
export type CriterionStatus = "evidenced" | "ruled_out" | "not_stated";

export interface CriterionAssessment {
  status: CriterionStatus;
  points: number;
  evidence: string;
}

export type Assessment = Record<CriterionKey, CriterionAssessment>;

export const ADVANCE_THRESHOLD = 70;

export type DecisionTool = "advance_to_interview" | "request_more_info" | "reject";

export function totalScore(assessment: Assessment): number {
  return CRITERION_KEYS.reduce((sum, key) => sum + assessment[key].points, 0);
}

/**
 * Best score the candidate could reach if every not_stated criterion came back
 * at full marks. If even that can't clear the bar, asking for more info is
 * pointless and the recommendation is a rejection.
 */
export function scoreCeiling(assessment: Assessment): number {
  return CRITERION_KEYS.reduce(
    (sum, key) => sum + (assessment[key].status === "not_stated" ? CRITERIA[key].max : assessment[key].points),
    0,
  );
}

export function expectedDecision(score: number, ceiling: number): DecisionTool {
  if (score >= ADVANCE_THRESHOLD) return "advance_to_interview";
  if (ceiling >= ADVANCE_THRESHOLD) return "request_more_info";
  return "reject";
}

export function rubricAsText(): string {
  return CRITERION_KEYS.map((key) => {
    const c = CRITERIA[key];
    return `- ${key} (max ${c.max}) — ${c.label}\n${c.anchors.map((a) => `    • ${a}`).join("\n")}`;
  }).join("\n");
}
