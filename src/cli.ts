#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "@actions/core";
import { loadConfig } from "./config.js";
import { collectDiff } from "./git.js";
import {
  fetchOpenPROverlap,
  getPRContext,
  upsertComment,
  type PRContext,
} from "./github.js";
import { runRules } from "./analyzer/rules.js";
import { buildClaudePrompt, loadSemanticAnalysis } from "./analyzer/semantic.js";
import { assembleReport } from "./analyzer/index.js";
import { renderMarkdown } from "./report/markdown.js";
import type { PROverlap } from "./report/schema.js";

const HELP = `pullstack — PR collaboration-risk analyzer for AI-assisted teams

Usage:
  pullstack analyze [options]

Options:
  --base <ref>       Base ref to diff against (default: $GITHUB_BASE_REF or origin/main)
  --head <ref>       Head ref (default: HEAD)
  --out-dir <dir>    Output directory (default: .pullstack)
  --config <file>    Config file (default: .pullstack.yml if present)
  --comment <bool>   Post/update PR comment (default: true in GitHub Actions PRs)
  -h, --help         Show this help

Outputs (in --out-dir):
  report.json, report.md, claude-analysis-prompt.md
`;

const VALUE_OPTS = new Set(["base", "head", "out-dir", "config", "comment"]);

type Args = {
  _: string[];
  base?: string;
  head?: string;
  "out-dir"?: string;
  config?: string;
  comment?: string;
  help?: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "-h" || tok === "--help") {
      args.help = true;
      continue;
    }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq >= 0) {
        const key = tok.slice(2, eq);
        (args as Record<string, unknown>)[key] = tok.slice(eq + 1);
      } else {
        const key = tok.slice(2);
        if (VALUE_OPTS.has(key)) {
          (args as Record<string, unknown>)[key] = argv[++i];
        } else {
          (args as Record<string, unknown>)[key] = "true";
        }
      }
    } else {
      args._.push(tok);
    }
  }
  return args;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function resolveBaseInput(cliBase: string | undefined, defaultBase: string): string {
  if (cliBase) return cliBase;
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  return defaultBase || "origin/main";
}

async function runAnalyze(args: Args): Promise<number> {
  const config = loadConfig(args.config);

  const baseInput = resolveBaseInput(args.base, config.project.default_base);
  const headInput = args.head ?? "HEAD";
  const outDir = args["out-dir"] ?? ".pullstack";

  mkdirSync(outDir, { recursive: true });

  console.log(`PullStack: diffing ${baseInput}...${headInput}`);
  const diff = collectDiff(baseInput, headInput);
  console.log(
    `PullStack: ${diff.changedFiles.length} changed file(s), +${diff.totalAdded}/-${diff.totalDeleted}`,
  );

  // GitHub context (PR overlap + commenting).
  const inActions = process.env.GITHUB_ACTIONS === "true";
  const token = process.env.GITHUB_TOKEN ?? process.env.INPUT_GITHUB_TOKEN;
  const prContext: PRContext | null = inActions ? getPRContext() : null;

  // Rule 8: PR overlap (best-effort).
  let overlap: PROverlap[] = [];
  if (prContext && token) {
    overlap = await fetchOpenPROverlap(token, prContext, diff.changedFiles);
    if (overlap.length) console.log(`PullStack: found overlap with ${overlap.length} open PR(s)`);
  }

  // Deterministic rules.
  const deterministic = runRules({ config, diff, overlap });

  // Claude semantic-analysis prompt.
  const prompt = buildClaudePrompt({
    project: config.project.name,
    diff,
    findings: deterministic,
    prTitle: prContext?.title,
    prBody: prContext?.body,
  });
  const promptPath = join(outDir, "claude-analysis-prompt.md");
  writeFileSync(promptPath, prompt, "utf8");

  // Merge semantic analysis if present.
  const semantic = loadSemanticAnalysis(join(outDir, "semantic-analysis.json"));
  if (semantic.status === "ok") console.log("PullStack: merged semantic-analysis.json");
  else if (semantic.status === "invalid")
    console.warn(`PullStack: semantic-analysis.json invalid (${semantic.error})`);

  const report = assembleReport({
    config,
    diff,
    overlap,
    deterministic,
    semantic,
    generatedAt: new Date().toISOString(),
    meta: { prTitle: prContext?.title },
  });

  const markdown = renderMarkdown(report);

  // Write outputs.
  const jsonPath = join(outDir, "report.json");
  const mdPath = join(outDir, "report.md");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  writeFileSync(mdPath, markdown + "\n", "utf8");

  console.log(
    `PullStack: risk ${report.risk.score}/100 (${report.risk.level}), recommendation: ${report.mergeRecommendation}`,
  );
  console.log(`PullStack: wrote ${jsonPath}, ${mdPath}, ${promptPath}`);

  // GitHub Actions outputs.
  if (inActions) {
    core.setOutput("risk_score", String(report.risk.score));
    core.setOutput("risk_level", report.risk.level);
    core.setOutput("merge_recommendation", report.mergeRecommendation);
  }

  // Comment on PR.
  const shouldComment = parseBool(args.comment, Boolean(inActions && prContext && token));
  if (shouldComment) {
    if (!prContext || !token) {
      console.warn(
        "PullStack: --comment requested but no PR context / GITHUB_TOKEN available; skipping.",
      );
    } else if (prContext.isFork) {
      console.warn(
        "PullStack: PR is from a fork; skipping comment (token is read-only). Report is in artifacts.",
      );
    } else {
      const ok = await upsertComment(token, prContext, markdown);
      console.log(ok ? "PullStack: posted PR comment." : "PullStack: could not post PR comment.");
    }
  }

  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "analyze";

  if (args.help || command === "help") {
    console.log(HELP);
    return;
  }

  if (command !== "analyze") {
    console.error(`Unknown command: ${command}\n`);
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  const code = await runAnalyze(args);
  process.exitCode = code;
}

main().catch((err) => {
  console.error(`PullStack failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
