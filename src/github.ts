import * as core from "@actions/core";
import * as github from "@actions/github";
import type { PROverlap } from "./report/schema.js";

export const REPORT_MARKER = "<!-- pullstack-report -->";

export type PRContext = {
  owner: string;
  repo: string;
  prNumber: number;
  title?: string;
  body?: string;
  isFork: boolean;
};

/** Returns PR context when running inside a GitHub Actions pull_request event. */
export function getPRContext(): PRContext | null {
  try {
    const ctx = github.context;
    const pr = ctx.payload.pull_request as
      | {
          number: number;
          title?: string;
          body?: string;
          head?: { repo?: { full_name?: string } };
          base?: { repo?: { full_name?: string } };
        }
      | undefined;
    if (!pr) return null;

    const headRepo = pr.head?.repo?.full_name;
    const baseRepo = pr.base?.repo?.full_name;
    const isFork = Boolean(headRepo && baseRepo && headRepo !== baseRepo);

    return {
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      prNumber: pr.number,
      title: pr.title,
      body: pr.body ?? undefined,
      isFork,
    };
  } catch {
    return null;
  }
}

/**
 * Find other open PRs whose changed files overlap with the current PR.
 * Returns an empty array (and never throws) when the API is unavailable.
 */
export async function fetchOpenPROverlap(
  token: string,
  pr: PRContext,
  changedFiles: string[],
): Promise<PROverlap[]> {
  const changed = new Set(changedFiles);
  if (changed.size === 0) return [];

  try {
    const octokit = github.getOctokit(token);
    const openPrs = await octokit.paginate(octokit.rest.pulls.list, {
      owner: pr.owner,
      repo: pr.repo,
      state: "open",
      per_page: 100,
    });

    const overlaps: PROverlap[] = [];
    for (const other of openPrs) {
      if (other.number === pr.prNumber) continue;
      const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner: pr.owner,
        repo: pr.repo,
        pull_number: other.number,
        per_page: 100,
      });
      const overlappingFiles = files
        .map((f) => f.filename)
        .filter((f) => changed.has(f));
      if (overlappingFiles.length > 0) {
        overlaps.push({
          number: other.number,
          title: other.title,
          url: other.html_url,
          author: other.user?.login,
          overlappingFiles,
        });
      }
    }
    return overlaps;
  } catch (err) {
    core.warning(`PullStack: could not fetch open PR overlap: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Create or update the single PullStack report comment on a PR (deduped via
 * the HTML marker). Returns true on success.
 */
export async function upsertComment(
  token: string,
  pr: PRContext,
  body: string,
): Promise<boolean> {
  try {
    const octokit = github.getOctokit(token);
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.prNumber,
      per_page: 100,
    });
    const existing = comments.find((c) => c.body?.includes(REPORT_MARKER));
    if (existing) {
      await octokit.rest.issues.updateComment({
        owner: pr.owner,
        repo: pr.repo,
        comment_id: existing.id,
        body,
      });
    } else {
      await octokit.rest.issues.createComment({
        owner: pr.owner,
        repo: pr.repo,
        issue_number: pr.prNumber,
        body,
      });
    }
    return true;
  } catch (err) {
    core.warning(
      `PullStack: could not post PR comment (likely a fork PR with read-only token): ${(err as Error).message}`,
    );
    return false;
  }
}
