import { describe, expect, it } from "vitest";
import {
  computeScore,
  levelFromScore,
  mergeRecommendation,
  weightForFinding,
} from "../analyzer/scoring.js";
import type { Finding } from "../report/schema.js";

function finding(partial: Partial<Finding> & Pick<Finding, "id" | "severity">): Finding {
  return {
    title: partial.title ?? partial.id,
    category: partial.category ?? "size",
    message: partial.message ?? "",
    ...partial,
  };
}

describe("weightForFinding", () => {
  it("weights core rules per spec", () => {
    expect(weightForFinding(finding({ id: "large-pr", severity: "medium" }))).toBe(10);
    expect(weightForFinding(finding({ id: "large-pr", severity: "high" }))).toBe(20);
    expect(weightForFinding(finding({ id: "shared-contract", severity: "high" }))).toBe(25);
    expect(weightForFinding(finding({ id: "protected-path", severity: "high" }))).toBe(25);
    expect(weightForFinding(finding({ id: "protected-path", severity: "critical" }))).toBe(40);
    expect(weightForFinding(finding({ id: "missing-tests", severity: "medium" }))).toBe(15);
    expect(weightForFinding(finding({ id: "scope-allowed-violation", severity: "high" }))).toBe(20);
    expect(weightForFinding(finding({ id: "scope-forbidden-violation", severity: "critical" }))).toBe(35);
  });

  it("weights semantic findings by severity", () => {
    expect(weightForFinding(finding({ id: "semantic:finding:0", severity: "critical" }))).toBe(25);
    expect(weightForFinding(finding({ id: "semantic:finding:1", severity: "high" }))).toBe(15);
    expect(weightForFinding(finding({ id: "semantic:finding:2", severity: "low" }))).toBe(0);
  });

  it("gives ownership and overlap findings zero direct weight", () => {
    expect(weightForFinding(finding({ id: "owner-review:@x", severity: "info" }))).toBe(0);
    expect(weightForFinding(finding({ id: "pr-overlap:1", severity: "medium" }))).toBe(0);
  });
});

describe("computeScore", () => {
  it("sums weights and caps at 100", () => {
    const findings = [
      finding({ id: "shared-contract", severity: "high" }), // 25
      finding({ id: "protected-path", severity: "critical" }), // 40
      finding({ id: "missing-tests", severity: "medium" }), // 15
      finding({ id: "scope-forbidden-violation", severity: "critical" }), // 35
    ];
    expect(computeScore(findings)).toBe(100); // 115 -> capped
  });

  it("caps the total overlap contribution at 30", () => {
    const overlaps = Array.from({ length: 6 }, (_, i) =>
      finding({ id: `pr-overlap:${i}`, severity: "medium" }),
    );
    expect(computeScore(overlaps)).toBe(30);
  });

  it("adds 10 per overlapping PR below the cap", () => {
    const overlaps = [
      finding({ id: "pr-overlap:1", severity: "medium" }),
      finding({ id: "pr-overlap:2", severity: "medium" }),
    ];
    expect(computeScore(overlaps)).toBe(20);
  });

  it("is zero with no findings", () => {
    expect(computeScore([])).toBe(0);
  });
});

describe("levelFromScore", () => {
  it("maps score ranges to levels", () => {
    expect(levelFromScore(0)).toBe("low");
    expect(levelFromScore(24)).toBe("low");
    expect(levelFromScore(25)).toBe("medium");
    expect(levelFromScore(49)).toBe("medium");
    expect(levelFromScore(50)).toBe("high");
    expect(levelFromScore(74)).toBe("high");
    expect(levelFromScore(75)).toBe("critical");
    expect(levelFromScore(100)).toBe("critical");
  });
});

describe("mergeRecommendation", () => {
  it("maps levels to recommendations", () => {
    expect(mergeRecommendation(10, [])).toBe("safe_to_merge");
    expect(mergeRecommendation(30, [])).toBe("needs_review");
    expect(mergeRecommendation(60, [])).toBe("needs_review");
    expect(mergeRecommendation(80, [])).toBe("blocked");
  });

  it("blocks when protected path + missing tests occur together", () => {
    const findings = [
      finding({ id: "protected-path", severity: "high", category: "protected-path" }),
      finding({ id: "missing-tests", severity: "medium", category: "tests" }),
    ];
    // score = 25 + 15 = 40 -> medium -> would be needs_review, override -> blocked
    expect(mergeRecommendation(40, findings)).toBe("blocked");
  });

  it("escalates shared-contract + missing-tests to at least needs_review", () => {
    const findings = [
      finding({ id: "shared-contract", severity: "high", category: "shared-contract" }),
      finding({ id: "missing-tests", severity: "medium", category: "tests" }),
    ];
    // score 40 -> medium -> needs_review (not blocked because < 50)
    expect(mergeRecommendation(40, findings)).toBe("needs_review");
    // higher score -> blocked
    expect(mergeRecommendation(60, findings)).toBe("blocked");
  });

  it("only escalates from the semantic status, never downgrades", () => {
    expect(mergeRecommendation(10, [], "blocked")).toBe("blocked");
    expect(mergeRecommendation(80, [], "safe_to_merge")).toBe("blocked");
  });
});
