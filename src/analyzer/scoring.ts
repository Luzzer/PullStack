import type {
  Finding,
  Recommendation,
  RiskLevel,
} from "../report/schema.js";

/** Maximum contribution from all PR-overlap findings combined. */
const OVERLAP_CAP = 30;
const OVERLAP_PER_PR = 10;

/**
 * Risk weight for a single finding. Overlap findings are summed separately
 * (and capped) by {@link computeScore}, so they return 0 here.
 */
export function weightForFinding(f: Finding): number {
  // Semantic findings (ids prefixed "semantic") are weighted by severity.
  if (f.id.startsWith("semantic")) {
    switch (f.severity) {
      case "critical":
        return 25;
      case "high":
        return 15;
      case "medium":
        return 5;
      default:
        return 0;
    }
  }

  switch (f.id) {
    case "large-pr":
      return f.severity === "high" ? 20 : 10;
    case "shared-contract":
      return 25;
    case "protected-path":
      return f.severity === "critical" ? 40 : 25;
    case "missing-tests":
      return 15;
    case "scope-allowed-violation":
      return 20;
    case "scope-forbidden-violation":
      return 35;
    default:
      return 0; // ownership, overlap (handled separately), unknown.
  }
}

/** Compute the 0-100 risk score from findings. */
export function computeScore(findings: Finding[]): number {
  let score = 0;
  let overlapCount = 0;
  for (const f of findings) {
    if (f.id.startsWith("pr-overlap")) {
      overlapCount += 1;
      continue;
    }
    score += weightForFinding(f);
  }
  score += Math.min(overlapCount * OVERLAP_PER_PR, OVERLAP_CAP);
  return Math.min(score, 100);
}

export function levelFromScore(score: number): RiskLevel {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

const RECOMMENDATION_RANK: Record<Recommendation, number> = {
  safe_to_merge: 0,
  needs_review: 1,
  blocked: 2,
};

/** Returns the more severe of two recommendations. */
export function escalate(a: Recommendation, b: Recommendation): Recommendation {
  return RECOMMENDATION_RANK[a] >= RECOMMENDATION_RANK[b] ? a : b;
}

function hasFinding(findings: Finding[], idPrefix: string): boolean {
  return findings.some((f) => f.id === idPrefix || f.id.startsWith(idPrefix));
}

/**
 * Derive a merge recommendation from the risk level, plus rule-combination
 * overrides and (optionally) the semantic merge status. Overrides may only
 * escalate, never downgrade.
 */
export function mergeRecommendation(
  score: number,
  findings: Finding[],
  semanticStatus?: Recommendation,
): Recommendation {
  const level = levelFromScore(score);
  let rec: Recommendation =
    level === "low"
      ? "safe_to_merge"
      : level === "critical"
        ? "blocked"
        : "needs_review";

  const protectedChanged = hasFinding(findings, "protected-path");
  const sharedChanged = hasFinding(findings, "shared-contract");
  const missingTests = hasFinding(findings, "missing-tests");
  const forbiddenScope = hasFinding(findings, "scope-forbidden-violation");

  // Protected path + missing tests => blocked.
  if (protectedChanged && missingTests) {
    rec = escalate(rec, "blocked");
  }
  // Shared contract + missing tests => at least needs_review, blocked if risky.
  if (sharedChanged && missingTests) {
    rec = escalate(rec, score >= 50 ? "blocked" : "needs_review");
  }
  // Forbidden scope violation => blocked.
  if (forbiddenScope) {
    rec = escalate(rec, "blocked");
  }
  // Honor (but only escalate to) the Claude semantic recommendation.
  if (semanticStatus) {
    rec = escalate(rec, semanticStatus);
  }

  return rec;
}

export function computeRisk(
  findings: Finding[],
  semanticStatus?: Recommendation,
): { score: number; level: RiskLevel; recommendation: Recommendation } {
  const score = computeScore(findings);
  return {
    score,
    level: levelFromScore(score),
    recommendation: mergeRecommendation(score, findings, semanticStatus),
  };
}
