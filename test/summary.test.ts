import { describe, expect, it } from "vitest";
import { renderSummary } from "../src/infra/summary.ts";

describe("run summary", () => {
  it("renders one row per application and escapes table characters", () => {
    const md = renderSummary({
      runId: "run_1",
      requestedModel: "gemini-test",
      servedBy: ["gemini-test-001"],
      rubricVersion: "v",
      promptSha256: "abcdef0123456789",
      rows: [
        { application_id: "A", status: "advanced_to_interview", score: 80, flags: [], reason: "Strong | clear" },
        {
          application_id: "C",
          status: "needs_human_review",
          score: null,
          flags: ["injection_scanner_hit"],
          reason: "x",
        },
      ],
    });
    expect(md).toContain("served by: `gemini-test-001`");
    expect(md).toContain("| A | advanced_to_interview | 80 | — | Strong \\| clear |");
    expect(md).toContain("| C | needs_human_review | — | injection_scanner_hit | x |");
  });
});
