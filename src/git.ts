import { execFileSync } from "node:child_process";
import type { DiffData, FileStat } from "./report/schema.js";

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** True if `ref` resolves to a commit in the repo. */
export function refExists(ref: string, cwd?: string): boolean {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a base ref, trying a couple of sensible fallbacks so a missing
 * `origin/main` does not crash the run.
 */
export function resolveBase(base: string, cwd?: string): string {
  const candidates = [base];
  if (!base.includes("/")) {
    candidates.push(`origin/${base}`);
  }
  // `main` <-> `master` convenience fallbacks.
  if (base === "origin/main" || base === "main") {
    candidates.push("origin/master", "master");
  }
  for (const candidate of candidates) {
    if (refExists(candidate, cwd)) return candidate;
  }
  throw new Error(
    `Base ref not found (tried: ${candidates.join(", ")}).\n` +
      `Pass an explicit base with --base <ref> (e.g. --base origin/main), ` +
      `and make sure history is available (in CI use actions/checkout with fetch-depth: 0).`,
  );
}

/**
 * Collect changed files, per-file line stats and the full diff between
 * `baseInput...headInput` (merge-base / three-dot diff).
 */
export function collectDiff(baseInput: string, headInput: string, cwd?: string): DiffData {
  const base = resolveBase(baseInput, cwd);

  if (!refExists(headInput, cwd)) {
    throw new Error(`Head ref not found: ${headInput}. Pass a valid --head <ref>.`);
  }
  // Resolve head to a stable label for the report.
  let head = headInput;
  try {
    head = git(["rev-parse", "--abbrev-ref", headInput], cwd).trim() || headInput;
    if (head === "HEAD") head = headInput;
  } catch {
    /* keep headInput */
  }

  const range = `${base}...${headInput}`;
  let nameOnly: string;
  let numstat: string;
  let diffText: string;
  try {
    nameOnly = git(["diff", "--name-only", range], cwd);
    numstat = git(["diff", "--numstat", range], cwd);
    diffText = git(["diff", range], cwd);
  } catch (err) {
    throw new Error(
      `Failed to compute git diff for '${range}': ${(err as Error).message}\n` +
        `The base and head may have no common ancestor. Try a different --base ` +
        `or run 'git fetch origin' first.`,
    );
  }

  const changedFiles = nameOnly
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const stats: FileStat[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  for (const line of numstat.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.trim()) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const [addedRaw, deletedRaw, ...rest] = parts;
    const file = rest.join("\t");
    // Binary files report "-" for added/deleted.
    const added = addedRaw === "-" ? 0 : Number.parseInt(addedRaw ?? "0", 10) || 0;
    const deleted = deletedRaw === "-" ? 0 : Number.parseInt(deletedRaw ?? "0", 10) || 0;
    stats.push({ file, added, deleted });
    totalAdded += added;
    totalDeleted += deleted;
  }

  return {
    base,
    head,
    changedFiles,
    stats,
    totalAdded,
    totalDeleted,
    diffText,
  };
}
