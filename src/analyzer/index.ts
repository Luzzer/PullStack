import type {
  Config,
  DiffData,
  Finding,
  PROverlap,
  Report,
  ReviewFocusItem,
} from "../report/schema.js";
import { computeRisk } from "./scoring.js";
import { filterMatching, runRules } from "./rules.js";
import {
  semanticToFindings,
  type SemanticLoadResult,
} from "./semantic.js";

export { runRules } from "./rules.js";
export { buildClaudePrompt, loadSemanticAnalysis } from "./semantic.js";
export { computeRisk } from "./scoring.js";

const SCHEMA_VERSION = "1.0";

export type AssembleInput = {
  config: Config;
  diff: DiffData;
  overlap: PROverlap[];
  /** Findings from the deterministic rule engine (run once, also used for the prompt). */
  deterministic: Finding[];
  semantic: SemanticLoadResult;
  generatedAt: string;
  meta?: { prTitle?: string };
};

/* ------------------------------------------------------------------ *
 * Derived sections
 * ------------------------------------------------------------------ */

function buildReviewFocus(
  findings: Finding[],
  semantic: SemanticLoadResult,
): ReviewFocusItem[] {
  const items: ReviewFocusItem[] = [];
  const seen = new Set<string>();
  const add = (file: string, reason: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    items.push({ file, reason });
  };

  // Semantic review focus first (most specific).
  if (semantic.status === "ok") {
    for (const rf of semantic.data.review_focus) {
      add(rf.file, rf.reason || "Flagged by semantic analysis.");
    }
  }

  // Then shared-contract / protected / scope finding files.
  const priority = findings.filter((f) =>
    ["shared-contract", "protected-path", "scope"].includes(f.category),
  );
  for (const f of priority) {
    for (const file of f.files ?? []) {
      add(file, f.title);
    }
  }

  return items.slice(0, 12);
}

function buildSuggestedReviewers(config: Config, diff: DiffData): string[] {
  const reviewers = new Set<string>();
  for (const owner of config.owners) {
    if (owner.reviewers.length === 0) continue;
    if (filterMatching(diff.changedFiles, owner.paths).length > 0) {
      owner.reviewers.forEach((r) => reviewers.add(r));
    }
  }
  return [...reviewers];
}

function buildSummary(
  diff: DiffData,
  findings: Finding[],
  semantic: SemanticLoadResult,
): string {
  if (semantic.status === "ok" && semantic.data.summary.trim()) {
    return semantic.data.summary.trim();
  }
  const parts: string[] = [
    `This PR changes ${diff.changedFiles.length} file(s) (+${diff.totalAdded}/-${diff.totalDeleted}).`,
  ];
  const has = (cat: string) => findings.some((f) => f.category === cat);
  if (has("shared-contract")) parts.push("It modifies shared contract files.");
  if (has("protected-path")) parts.push("It touches protected paths.");
  if (findings.some((f) => f.id === "missing-tests")) parts.push("No test files were changed.");
  if (findings.some((f) => f.id.startsWith("pr-overlap"))) parts.push("It overlaps with other open PRs.");
  if (parts.length === 1) parts.push("No significant deterministic risk signals were found.");
  return parts.join(" ");
}

function buildNextSteps(
  findings: Finding[],
  overlap: PROverlap[],
  semantic: SemanticLoadResult,
): string[] {
  const steps: string[] = [];
  const has = (id: string) => findings.some((f) => f.id === id || f.id.startsWith(id));

  if (has("missing-tests")) steps.push("Add or update tests for the changed behavior.");
  if (has("shared-contract") || has("semantic:contract"))
    steps.push("Confirm backward compatibility of shared contract changes and notify dependent teams.");
  if (has("protected-path"))
    steps.push("Request code-owner approval for protected-path changes.");
  if (has("scope-allowed-violation") || has("scope-forbidden-violation") || has("semantic:scope-drift"))
    steps.push("Re-scope the PR: move out-of-scope changes to a separate PR.");
  for (const o of overlap) {
    steps.push(`Coordinate merge order with PR #${o.number} and rebase to avoid conflicts.`);
  }
  if (has("large-pr")) steps.push("Consider splitting this large PR into smaller stacked PRs.");

  if (semantic.status === "ok") {
    const split = semantic.data.split_recommendation;
    if (split?.should_split) {
      steps.push(`Split recommended: ${split.reason || "see semantic analysis"}.`);
    }
  } else if (semantic.status === "absent") {
    steps.push(
      "Run Claude Code on `.pullstack/claude-analysis-prompt.md` to add semantic analysis.",
    );
  }

  if (steps.length === 0) steps.push("No action required — looks safe to merge.");
  return steps;
}

/* ------------------------------------------------------------------ *
 * Assemble the final report (deterministic + semantic)
 * ------------------------------------------------------------------ */

export function assembleReport(input: AssembleInput): Report {
  const { config, diff, overlap, deterministic, semantic, generatedAt } = input;

  const semanticFindings =
    semantic.status === "ok" ? semanticToFindings(semantic.data) : [];

  const warningFindings: Finding[] =
    semantic.status === "invalid"
      ? [
          {
            id: "semantic-warning",
            title: "Semantic analysis file invalid",
            severity: "low",
            category: "semantic",
            message: `.pullstack/semantic-analysis.json was present but could not be used: ${semantic.error}`,
            recommendation:
              "Regenerate it from .pullstack/claude-analysis-prompt.md (must be valid JSON).",
          },
        ]
      : [];

  const findings = [...deterministic, ...semanticFindings, ...warningFindings];

  const semanticStatus =
    semantic.status === "ok" ? semantic.data.merge_recommendation?.status : undefined;
  const risk = computeRisk(findings, semanticStatus);

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    project: config.project.name,
    base: diff.base,
    head: diff.head,
    prTitle: input.meta?.prTitle,
    changedFiles: diff.changedFiles,
    stats: {
      changedFiles: diff.changedFiles.length,
      added: diff.totalAdded,
      deleted: diff.totalDeleted,
    },
    risk: { score: risk.score, level: risk.level },
    mergeRecommendation: risk.recommendation,
    summary: buildSummary(diff, findings, semantic),
    findings,
    reviewFocus: buildReviewFocus(findings, semantic),
    suggestedReviewers: buildSuggestedReviewers(config, diff),
    overlap,
    nextSteps: buildNextSteps(findings, overlap, semantic),
    semantic: {
      status: semantic.status,
      splitRecommended:
        semantic.status === "ok"
          ? semantic.data.split_recommendation?.should_split
          : undefined,
      splitReason:
        semantic.status === "ok"
          ? semantic.data.split_recommendation?.reason
          : undefined,
      note:
        semantic.status === "invalid"
          ? semantic.error
          : semantic.status === "absent"
            ? "No semantic-analysis.json found; report is deterministic-only."
            : undefined,
    },
  };
}

/** Convenience: run rules + assemble in one call (used when the prompt isn't needed separately). */
export function analyze(
  input: Omit<AssembleInput, "deterministic"> & { deterministic?: Finding[] },
): Report {
  const deterministic =
    input.deterministic ??
    runRules({ config: input.config, diff: input.diff, overlap: input.overlap });
  return assembleReport({ ...input, deterministic });
}
