# PullStack

📖 **Language:** [English](README.md) · [한국어](README.ko.md)

**A GitHub PR collaboration-risk analyzer for teams shipping AI-assisted code.**

PullStack is **not a code generator** and **not a generic AI reviewer**. It is a
merge-risk analyzer for teams using Claude Code, Codex, Cursor, or similar tools.
AI makes it easy to produce large, fast-moving PRs — PullStack helps you merge
them *safely* by surfacing collaboration and merge-ordering risk.

It answers questions like:

- Did this PR quietly drift outside its declared scope?
- Did it change a **shared contract** (types / API / schema) other teams depend on?
- Did it change code but ship **no tests**?
- Does it **overlap** with other open PRs (and what should merge first)?
- Did it touch a **protected path** (auth, security, migrations, CI)?
- What should reviewers actually **focus** on?
- Should it be **split** into smaller stacked PRs?

## How it works — hybrid analysis

PullStack combines two layers:

1. **Deterministic rule engine** (always runs, no network, no LLM): changed
   files, diff size, shared-contract globs, protected paths, missing tests,
   declared-scope violations, code-owner matching, and open-PR overlap.
2. **Claude semantic layer** (optional): PullStack generates a prompt
   (`.pullstack/claude-analysis-prompt.md`) that a Claude Code Action — or a
   human running Claude Code — uses to judge scope drift, contract changes,
   review focus, split recommendations, and a merge call. The result
   (`.pullstack/semantic-analysis.json`) is merged into the final report.

> This MVP does **not** call the Anthropic API directly. It produces a prompt
> and consumes the JSON a separate Claude Code step writes. This keeps the tool
> deterministic, cheap to run, and easy to drop into CI.

## MVP scope

- Runs locally and inside GitHub Actions on pull requests.
- Produces `.pullstack/report.json`, `.pullstack/report.md`, and
  `.pullstack/claude-analysis-prompt.md`.
- Posts/updates a single deduped PR comment.
- No SaaS dashboard, no database, no LLM API calls. Just a usable POC.

## Outputs

| File | What it is |
|---|---|
| `.pullstack/report.json` | Full machine-readable report (findings, score, recommendation). |
| `.pullstack/report.md` | Human-readable PR comment (with the `<!-- pullstack-report -->` marker). |
| `.pullstack/claude-analysis-prompt.md` | Prompt for Claude Code to produce semantic analysis. |
| `.pullstack/semantic-analysis.json` | *(input)* If present, merged into the report. |

## Install & local usage

```bash
npm install
npm run build
npm test

# Analyze the current branch against origin/main
npm run analyze -- --base origin/main --head HEAD

# Or via the built CLI / npx
node dist/cli.js analyze --base origin/main --head HEAD
npx pullstack analyze --base origin/main --head HEAD
```

### CLI options

```bash
pullstack analyze \
  --base origin/main \   # default: $GITHUB_BASE_REF (as origin/<ref>) or origin/main
  --head HEAD \          # default: HEAD
  --out-dir .pullstack \ # default: .pullstack
  --config .pullstack.yml \ # default: .pullstack.yml if present, else built-in defaults
  --comment false        # default: true only in GitHub Actions PRs with GITHUB_TOKEN
```

If diff collection fails (e.g. `origin/main` is missing), PullStack prints how to
pass `--base` and reminds you to use `fetch-depth: 0` in CI.

## GitHub Actions usage

Copy [`.github/workflows/pullstack.yml`](.github/workflows/pullstack.yml). It:

1. checks out with `fetch-depth: 0`,
2. sets up Node 20, installs, builds, tests,
3. runs `pullstack analyze`,
4. comments the report on the PR (deduped via the HTML marker),
5. uploads `report.md` / `report.json` / `claude-analysis-prompt.md` as artifacts.

Required permissions:

```yaml
permissions:
  contents: read
  pull-requests: write
```

## Using Claude Code semantic analysis

The deterministic layer is enough to be useful. To add the semantic layer:

1. Run `pullstack analyze --comment false` → writes `claude-analysis-prompt.md`.
2. Run Claude Code on that prompt. It writes `.pullstack/semantic-analysis.json`.
   - In CI: see [`.github/workflows/pullstack-claude.yml`](.github/workflows/pullstack-claude.yml)
     (an **example** — adjust the Claude Code Action step to your version).
   - Locally: open `.pullstack/claude-analysis-prompt.md` in Claude Code and let it
     write the JSON.
3. Run `pullstack analyze --comment true` again → merges semantic results and
   posts the final comment.

The semantic JSON schema is documented inside the generated prompt. If the file
is present but invalid, PullStack adds a low-severity warning finding and
continues — it never fails the whole run because of bad semantic JSON.

## `.pullstack.yml` config

Config is **optional**; without it, sensible defaults apply. Copy
[`.pullstack.example.yml`](.pullstack.example.yml) to `.pullstack.yml`.

| Key | Meaning |
|---|---|
| `project.name` / `project.default_base` | Display name and fallback base ref. |
| `risk.large_pr_*` | Thresholds for the "large PR" rule. |
| `shared_contracts` | Globs whose change is high-risk for other teams/code. |
| `protected_paths` | High-sensitivity globs (auth, security, migrations, infra, CI). |
| `test_patterns` | What counts as a test file (missing-tests rule). |
| `owners[].paths` / `owners[].reviewers` | CODEOWNERS-like reviewer suggestions. |
| `scope.declared_allowed_paths` | If set, changes outside are flagged as drift. |
| `scope.declared_forbidden_paths` | Changes touching these are flagged (critical). |

Globs use [minimatch](https://github.com/isaacs/minimatch) syntax (`dot: true`).

## Risk scoring

Findings contribute weighted points (capped at 100):

| Signal | Points |
|---|---|
| Large PR | +10 (or +20 if far over threshold) |
| Shared contract changed | +25 |
| Protected path changed | +25 (or +40 for security/migrations/CI/infra) |
| Missing tests | +15 |
| Scope allowed-path violation | +20 |
| Scope forbidden-path violation | +35 |
| PR overlap | +10 per PR, capped at +30 |
| Semantic high / critical finding | +15 / +25 |

Risk levels: `0–24 low`, `25–49 medium`, `50–74 high`, `75–100 critical`.

Merge recommendation: `low → safe_to_merge`, `medium/high → needs_review`,
`critical → blocked`. Overrides only ever escalate:

- protected path **and** missing tests → `blocked`
- shared contract **and** missing tests → at least `needs_review` (`blocked` if score ≥ 50)
- forbidden-scope violation → `blocked`
- the Claude semantic `merge_recommendation` can escalate but never downgrade.

## Security notes

- **Fork PRs:** GitHub gives fork PRs a read-only token. PullStack detects fork
  PRs and **skips commenting**, uploading the report as an artifact instead, so
  it never fails on permissions. Keep `pull-requests: write` for same-repo PRs.
- PullStack only runs **its own** scripts. It does not execute code from the PR
  under analysis — it reads the diff via `git` and the GitHub API only.
- Do not add `pull_request_target` with checkout of untrusted PR code; this
  workflow uses plain `pull_request`.
- The generated prompt embeds (a truncated slice of) the diff. If your repo
  contains secrets in diffs, treat the prompt/artifacts accordingly.

## Limitations

- The semantic layer requires a separate Claude Code step; without it the report
  is deterministic-only (still useful).
- PR overlap requires a GitHub token + PR context; it is skipped gracefully
  otherwise.
- Glob-based contract/ownership detection is heuristic — tune the config.
- The diff embedded in the prompt is truncated (~60 KB) for very large PRs.
- No persistence/history; each run is stateless.

## Roadmap

- Inline file/line annotations (review comments) for top findings.
- CODEOWNERS file parsing (in addition to inline `owners`).
- Merge-order/stacked-PR graph across all open PRs.
- Configurable score weights and per-team policy presets.
- Optional direct Anthropic API mode for fully-automated semantic analysis.

## License

MIT
