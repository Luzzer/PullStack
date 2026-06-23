import { existsSync, readFileSync } from "node:fs";
import {
  SemanticAnalysisSchema,
  type DiffData,
  type Finding,
  type SemanticAnalysis,
} from "../report/schema.js";

const MAX_DIFF_CHARS = 60_000;

export type SemanticLoadResult =
  | { status: "absent" }
  | { status: "ok"; data: SemanticAnalysis }
  | { status: "invalid"; error: string };

/* ------------------------------------------------------------------ *
 * Claude Code prompt generation
 * ------------------------------------------------------------------ */

export type PromptInput = {
  project: string;
  diff: DiffData;
  findings: Finding[];
  prTitle?: string;
  prBody?: string;
};

function findingsSummary(findings: Finding[]): string {
  if (findings.length === 0) return "_No deterministic findings._";
  return findings
    .map((f) => `- [${f.severity}] (${f.category}) ${f.title} — ${f.message}`)
    .join("\n");
}

function diffStatTable(diff: DiffData): string {
  if (diff.stats.length === 0) return "_No file stats available._";
  const rows = diff.stats
    .slice(0, 100)
    .map((s) => `| \`${s.file}\` | +${s.added} | -${s.deleted} |`)
    .join("\n");
  const more = diff.stats.length > 100 ? `\n_…and ${diff.stats.length - 100} more files._` : "";
  return `| File | Added | Deleted |\n|---|---|---|\n${rows}${more}`;
}

const SEMANTIC_JSON_SCHEMA = `{
  "summary": "string",
  "scope_drift": {
    "detected": true,
    "reason": "string",
    "files": ["string"]
  },
  "public_contract_changes": [
    { "file": "string", "reason": "string", "risk": "low|medium|high|critical" }
  ],
  "missing_test_concerns": [
    { "area": "string", "reason": "string", "suggested_test": "string" }
  ],
  "review_focus": [
    { "file": "string", "reason": "string" }
  ],
  "split_recommendation": {
    "should_split": true,
    "reason": "string",
    "suggested_prs": [
      { "title": "string", "files_or_scope": ["string"] }
    ]
  },
  "merge_recommendation": {
    "status": "safe_to_merge|needs_review|blocked",
    "reason": "string"
  },
  "findings": [
    {
      "title": "string",
      "severity": "info|low|medium|high|critical",
      "category": "scope|tests|shared-contract|protected-path|size|overlap|ownership|merge-order|semantic",
      "message": "string",
      "files": ["string"],
      "recommendation": "string"
    }
  ]
}`;

/** Build the prompt a Claude Code Action / human runs to produce semantic-analysis.json. */
export function buildClaudePrompt(input: PromptInput): string {
  const { project, diff, findings } = input;
  const truncatedDiff =
    diff.diffText.length > MAX_DIFF_CHARS
      ? diff.diffText.slice(0, MAX_DIFF_CHARS) +
        `\n\n... [diff truncated at ${MAX_DIFF_CHARS} characters for prompt size] ...`
      : diff.diffText;

  return `# PullStack — Claude Code Semantic Merge-Risk Analysis

You are not a normal code reviewer.
You are a merge-risk analyst for an AI-assisted coding team.

Do not suggest style nitpicks.
Do not rewrite code.
Focus only on merge safety and collaboration risk.
Return only valid JSON.

## Your job

Decide how safely this pull request can be merged alongside other in-flight
work. Specifically assess:

1. Whether the PR exceeds its declared/implied scope (scope drift).
2. Whether the PR description matches what the diff actually does.
3. Whether public contracts (types, APIs, schemas, events) appear to change.
4. What reviewers should focus on.
5. Whether the PR should be split into smaller stacked PRs.
6. An overall merge recommendation with reasoning.

## Context

- **Project:** ${project}
- **Base:** \`${diff.base}\`  **Head:** \`${diff.head}\`
- **Changed files:** ${diff.changedFiles.length}
- **Lines:** +${diff.totalAdded} / -${diff.totalDeleted}
${input.prTitle ? `- **PR title:** ${input.prTitle}\n` : ""}${
    input.prBody ? `\n### PR description\n\n${input.prBody}\n` : ""
  }
### Changed files

${diff.changedFiles.length ? diff.changedFiles.map((f) => `- \`${f}\``).join("\n") : "_none_"}

### Diff stat

${diffStatTable(diff)}

### Deterministic findings (from PullStack rule engine)

${findingsSummary(findings)}

## The diff

Inspect the diff below carefully before answering.

\`\`\`diff
${truncatedDiff || "(empty diff)"}
\`\`\`

## Output

Return **only** a single JSON object (no prose, no code fences) matching this schema:

\`\`\`json
${SEMANTIC_JSON_SCHEMA}
\`\`\`

Write the result to \`.pullstack/semantic-analysis.json\`.
`;
}

/* ------------------------------------------------------------------ *
 * Reading & validating the semantic analysis file
 * ------------------------------------------------------------------ */

export function loadSemanticAnalysis(filePath: string): SemanticLoadResult {
  if (!existsSync(filePath)) return { status: "absent" };

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    return { status: "invalid", error: `Could not read ${filePath}: ${(err as Error).message}` };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { status: "invalid", error: `Invalid JSON: ${(err as Error).message}` };
  }

  const parsed = SemanticAnalysisSchema.safeParse(json);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { status: "invalid", error };
  }
  return { status: "ok", data: parsed.data };
}

/* ------------------------------------------------------------------ *
 * Convert semantic analysis to findings for the merged report
 * ------------------------------------------------------------------ */

export function semanticToFindings(data: SemanticAnalysis): Finding[] {
  const findings: Finding[] = [];

  if (data.scope_drift?.detected) {
    findings.push({
      id: "semantic:scope-drift",
      title: "Scope drift detected (semantic)",
      severity: "high",
      category: "scope",
      message:
        data.scope_drift.reason || "The PR appears to exceed its declared scope.",
      files: data.scope_drift.files.length ? data.scope_drift.files : undefined,
      recommendation: "Re-scope the PR or split out the unrelated changes.",
    });
  }

  data.public_contract_changes.forEach((c, i) => {
    findings.push({
      id: `semantic:contract:${i}`,
      title: `Public contract change: ${c.file}`,
      severity: c.risk,
      category: "shared-contract",
      message: c.reason || `Public contract change in ${c.file}.`,
      files: [c.file],
      recommendation: "Verify downstream consumers and backward compatibility.",
    });
  });

  data.findings.forEach((f, i) => {
    findings.push({
      id: `semantic:finding:${i}`,
      title: f.title,
      severity: f.severity,
      category: f.category,
      message: f.message,
      files: f.files,
      recommendation: f.recommendation,
    });
  });

  return findings;
}
