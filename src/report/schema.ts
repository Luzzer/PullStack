import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Shared enums
 * ------------------------------------------------------------------ */

export const SeverityEnum = z.enum(["info", "low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof SeverityEnum>;

export const CategoryEnum = z.enum([
  "scope",
  "tests",
  "shared-contract",
  "protected-path",
  "size",
  "overlap",
  "ownership",
  "merge-order",
  "semantic",
]);
export type Category = z.infer<typeof CategoryEnum>;

export const RecommendationEnum = z.enum(["safe_to_merge", "needs_review", "blocked"]);
export type Recommendation = z.infer<typeof RecommendationEnum>;

export const RiskLevelEnum = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevelEnum>;

/* ------------------------------------------------------------------ *
 * Finding
 * ------------------------------------------------------------------ */

export const FindingSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: SeverityEnum,
  category: CategoryEnum,
  message: z.string(),
  files: z.array(z.string()).optional(),
  recommendation: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

/* ------------------------------------------------------------------ *
 * Diff / git data
 * ------------------------------------------------------------------ */

export type FileStat = {
  file: string;
  added: number;
  deleted: number;
};

export type DiffData = {
  base: string;
  head: string;
  changedFiles: string[];
  stats: FileStat[];
  totalAdded: number;
  totalDeleted: number;
  /** Full unified diff text. May be large; not embedded in report.json. */
  diffText: string;
};

/* ------------------------------------------------------------------ *
 * PR overlap (other open PRs touching the same files)
 * ------------------------------------------------------------------ */

export type PROverlap = {
  number: number;
  title: string;
  url?: string;
  author?: string;
  overlappingFiles: string[];
};

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

export const DEFAULT_SHARED_CONTRACTS = [
  "src/types.ts",
  "src/types/**",
  "src/api/**",
  "src/schema/**",
  "proto/**",
  "packages/*/src/types/**",
];

export const DEFAULT_PROTECTED_PATHS = [
  "src/auth/**",
  "src/security/**",
  "src/db/migrations/**",
  "infra/**",
  ".github/workflows/**",
];

export const DEFAULT_TEST_PATTERNS = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*_test.go",
  "**/*_test.py",
  "**/test_*.py",
  "tests/**",
  "test/**",
  "__tests__/**",
];

const OwnerSchema = z.object({
  paths: z.array(z.string()).default([]),
  reviewers: z.array(z.string()).default([]),
});

export const ConfigSchema = z
  .object({
    project: z
      .object({
        name: z.string().default("project"),
        default_base: z.string().default("origin/main"),
      })
      .default({}),
    risk: z
      .object({
        large_pr_changed_files: z.number().int().positive().default(20),
        large_pr_added_lines: z.number().int().positive().default(800),
        large_pr_deleted_lines: z.number().int().positive().default(400),
      })
      .default({}),
    shared_contracts: z.array(z.string()).default(DEFAULT_SHARED_CONTRACTS),
    protected_paths: z.array(z.string()).default(DEFAULT_PROTECTED_PATHS),
    test_patterns: z.array(z.string()).default(DEFAULT_TEST_PATTERNS),
    owners: z.array(OwnerSchema).default([]),
    scope: z
      .object({
        declared_allowed_paths: z.array(z.string()).default([]),
        declared_forbidden_paths: z.array(z.string()).default([]),
      })
      .default({}),
  })
  .default({});

export type Config = z.infer<typeof ConfigSchema>;
export type Owner = z.infer<typeof OwnerSchema>;

/* ------------------------------------------------------------------ *
 * Semantic analysis JSON (produced by Claude Code)
 * ------------------------------------------------------------------ */

const SemanticRiskEnum = z.enum(["low", "medium", "high", "critical"]);

const SemanticFindingSchema = z.object({
  title: z.string(),
  severity: SeverityEnum,
  // Unknown categories fall back to "semantic" instead of failing validation.
  category: CategoryEnum.catch("semantic"),
  message: z.string().default(""),
  files: z.array(z.string()).optional(),
  recommendation: z.string().optional(),
});

export const SemanticAnalysisSchema = z.object({
  summary: z.string().default(""),
  scope_drift: z
    .object({
      detected: z.boolean(),
      reason: z.string().default(""),
      files: z.array(z.string()).default([]),
    })
    .optional(),
  public_contract_changes: z
    .array(
      z.object({
        file: z.string(),
        reason: z.string().default(""),
        risk: SemanticRiskEnum.default("medium"),
      }),
    )
    .default([]),
  missing_test_concerns: z
    .array(
      z.object({
        area: z.string(),
        reason: z.string().default(""),
        suggested_test: z.string().default(""),
      }),
    )
    .default([]),
  review_focus: z
    .array(
      z.object({
        file: z.string(),
        reason: z.string().default(""),
      }),
    )
    .default([]),
  split_recommendation: z
    .object({
      should_split: z.boolean(),
      reason: z.string().default(""),
      suggested_prs: z
        .array(
          z.object({
            title: z.string(),
            files_or_scope: z.array(z.string()).default([]),
          }),
        )
        .default([]),
    })
    .optional(),
  merge_recommendation: z
    .object({
      status: RecommendationEnum,
      reason: z.string().default(""),
    })
    .optional(),
  findings: z.array(SemanticFindingSchema).default([]),
});

export type SemanticAnalysis = z.infer<typeof SemanticAnalysisSchema>;

/* ------------------------------------------------------------------ *
 * Final report
 * ------------------------------------------------------------------ */

export type ReviewFocusItem = {
  file: string;
  reason: string;
};

export type Report = {
  schemaVersion: string;
  generatedAt: string;
  project: string;
  base: string;
  head: string;
  prTitle?: string;
  changedFiles: string[];
  stats: {
    changedFiles: number;
    added: number;
    deleted: number;
  };
  risk: {
    score: number;
    level: RiskLevel;
  };
  mergeRecommendation: Recommendation;
  summary: string;
  findings: Finding[];
  reviewFocus: ReviewFocusItem[];
  suggestedReviewers: string[];
  overlap: PROverlap[];
  nextSteps: string[];
  semantic: {
    status: "absent" | "ok" | "invalid";
    splitRecommended?: boolean;
    splitReason?: string;
    note?: string;
  };
};
