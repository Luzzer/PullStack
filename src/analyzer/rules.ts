import { minimatch } from "minimatch";
import type {
  Config,
  DiffData,
  Finding,
  PROverlap,
  Severity,
} from "../report/schema.js";

/* ------------------------------------------------------------------ *
 * Glob helpers
 * ------------------------------------------------------------------ */

export function matchAny(file: string, patterns: string[]): boolean {
  return patterns.some((p) => minimatch(file, p, { dot: true }));
}

export function filterMatching(files: string[], patterns: string[]): string[] {
  return files.filter((f) => matchAny(f, patterns));
}

/* ------------------------------------------------------------------ *
 * Source vs test vs docs classification
 * ------------------------------------------------------------------ */

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".rb", ".php",
  ".cs", ".kt", ".kts", ".swift", ".scala",
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".m", ".mm",
]);

function extOf(file: string): string {
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  const name = slash >= 0 ? file.slice(slash + 1) : file;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export function isTestFile(file: string, config: Config): boolean {
  return matchAny(file, config.test_patterns);
}

/** A file that plausibly needs test coverage (code, but not a test itself). */
export function isSourceFile(file: string): boolean {
  return SOURCE_EXTENSIONS.has(extOf(file));
}

/* ------------------------------------------------------------------ *
 * Rule context
 * ------------------------------------------------------------------ */

export type RuleContext = {
  config: Config;
  diff: DiffData;
  overlap: PROverlap[];
};

/* ------------------------------------------------------------------ *
 * Rule 1: Large PR
 * ------------------------------------------------------------------ */

export function ruleLargePR({ config, diff }: RuleContext): Finding[] {
  const r = config.risk;
  const reasons: string[] = [];
  if (diff.changedFiles.length > r.large_pr_changed_files) {
    reasons.push(`${diff.changedFiles.length} files changed (threshold ${r.large_pr_changed_files})`);
  }
  if (diff.totalAdded > r.large_pr_added_lines) {
    reasons.push(`${diff.totalAdded} lines added (threshold ${r.large_pr_added_lines})`);
  }
  if (diff.totalDeleted > r.large_pr_deleted_lines) {
    reasons.push(`${diff.totalDeleted} lines deleted (threshold ${r.large_pr_deleted_lines})`);
  }
  if (reasons.length === 0) return [];

  const severe =
    diff.changedFiles.length > r.large_pr_changed_files * 2 ||
    diff.totalAdded > r.large_pr_added_lines * 2;

  return [
    {
      id: "large-pr",
      title: "Large pull request",
      severity: severe ? "high" : "medium",
      category: "size",
      message: `This PR is large: ${reasons.join("; ")}.`,
      recommendation: "Consider splitting into smaller, independently reviewable PRs.",
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Rule 2: Shared contract changed
 * ------------------------------------------------------------------ */

export function ruleSharedContract({ config, diff }: RuleContext): Finding[] {
  const matched = filterMatching(diff.changedFiles, config.shared_contracts);
  if (matched.length === 0) return [];
  return [
    {
      id: "shared-contract",
      title: "Shared contract files changed",
      severity: "high",
      category: "shared-contract",
      message: `Changes touch shared contract files other code/teams depend on: ${matched.join(", ")}.`,
      files: matched,
      recommendation:
        "Verify backward compatibility, version consumers if needed, and notify dependent teams.",
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Rule 3: Protected path changed
 * ------------------------------------------------------------------ */

// Subset of protected paths considered critical (migrations, security, CI, infra).
const CRITICAL_PROTECTED = [
  "**/db/migrations/**",
  "**/migrations/**",
  "**/security/**",
  "**/auth/**",
  "infra/**",
  "**/infra/**",
  ".github/workflows/**",
  "**/*secret*",
];

export function ruleProtectedPath({ config, diff }: RuleContext): Finding[] {
  const matched = filterMatching(diff.changedFiles, config.protected_paths);
  if (matched.length === 0) return [];
  const critical = matched.some((f) => matchAny(f, CRITICAL_PROTECTED));
  return [
    {
      id: "protected-path",
      title: "Protected path modified",
      severity: critical ? "critical" : "high",
      category: "protected-path",
      message: `Changes touch protected paths requiring extra scrutiny: ${matched.join(", ")}.`,
      files: matched,
      recommendation:
        "Require explicit code-owner approval; confirm the change is intentional and covered by tests.",
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Rule 4: Missing tests
 * ------------------------------------------------------------------ */

export function ruleMissingTests({ config, diff }: RuleContext): Finding[] {
  const testFiles = diff.changedFiles.filter((f) => isTestFile(f, config));
  const sourceFiles = diff.changedFiles.filter(
    (f) => isSourceFile(f) && !isTestFile(f, config),
  );
  // Docs-only or config-only changes have no source files -> no finding.
  if (sourceFiles.length === 0 || testFiles.length > 0) return [];

  return [
    {
      id: "missing-tests",
      title: "No test changes",
      severity: "medium",
      category: "tests",
      message: `${sourceFiles.length} source file(s) changed but no test files were added or modified.`,
      files: sourceFiles.slice(0, 25),
      recommendation: "Add or update tests covering the changed behavior.",
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Rule 5: Scope allowed-paths violation
 * ------------------------------------------------------------------ */

export function ruleScopeAllowed({ config, diff }: RuleContext): Finding[] {
  const allowed = config.scope.declared_allowed_paths;
  if (allowed.length === 0) return [];
  const violations = diff.changedFiles.filter((f) => !matchAny(f, allowed));
  if (violations.length === 0) return [];
  return [
    {
      id: "scope-allowed-violation",
      title: "Changes outside declared scope",
      severity: "high",
      category: "scope",
      message: `${violations.length} changed file(s) fall outside the declared allowed scope.`,
      files: violations,
      recommendation:
        "Confirm these changes belong in this PR, or move them to a separate PR.",
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Rule 6: Scope forbidden-paths violation
 * ------------------------------------------------------------------ */

export function ruleScopeForbidden({ config, diff }: RuleContext): Finding[] {
  const forbidden = config.scope.declared_forbidden_paths;
  if (forbidden.length === 0) return [];
  const matched = filterMatching(diff.changedFiles, forbidden);
  if (matched.length === 0) return [];
  return [
    {
      id: "scope-forbidden-violation",
      title: "Forbidden paths changed",
      severity: "critical",
      category: "scope",
      message: `Changes touch paths explicitly declared out-of-scope: ${matched.join(", ")}.`,
      files: matched,
      recommendation:
        "Remove these changes from the PR; they were declared off-limits for this change.",
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Rule 7: Owner review suggested
 * ------------------------------------------------------------------ */

export function ruleOwnerReview({ config, diff }: RuleContext): Finding[] {
  const findings: Finding[] = [];
  for (const owner of config.owners) {
    if (owner.reviewers.length === 0) continue;
    const matched = filterMatching(diff.changedFiles, owner.paths);
    if (matched.length === 0) continue;
    findings.push({
      id: `owner-review:${owner.reviewers.join(",")}`,
      title: "Code owner review suggested",
      severity: "info",
      category: "ownership",
      message: `Changes match owned paths; suggested reviewers: ${owner.reviewers.join(", ")}.`,
      files: matched,
      recommendation: `Request review from ${owner.reviewers.join(", ")}.`,
    });
  }
  return findings;
}

/* ------------------------------------------------------------------ *
 * Rule 8: PR overlap
 * ------------------------------------------------------------------ */

export function ruleOverlap({ overlap }: RuleContext): Finding[] {
  return overlap.map((o) => ({
    id: `pr-overlap:${o.number}`,
    title: `File overlap with PR #${o.number}`,
    severity: "medium" as Severity,
    category: "overlap" as const,
    message: `This PR changes files also changed by open PR #${o.number} ("${o.title}"): ${o.overlappingFiles.join(", ")}.`,
    files: o.overlappingFiles,
    recommendation: `Coordinate merge order with #${o.number} and rebase to avoid conflicts.`,
  }));
}

/* ------------------------------------------------------------------ *
 * Run all deterministic rules
 * ------------------------------------------------------------------ */

export function runRules(ctx: RuleContext): Finding[] {
  return [
    ...ruleLargePR(ctx),
    ...ruleSharedContract(ctx),
    ...ruleProtectedPath(ctx),
    ...ruleMissingTests(ctx),
    ...ruleScopeAllowed(ctx),
    ...ruleScopeForbidden(ctx),
    ...ruleOwnerReview(ctx),
    ...ruleOverlap(ctx),
  ];
}
