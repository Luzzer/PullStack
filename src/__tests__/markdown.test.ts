import { describe, expect, it } from "vitest";
import { assembleReport } from "../analyzer/index.js";
import { runRules } from "../analyzer/rules.js";
import { renderMarkdown, REPORT_MARKER } from "../report/markdown.js";
import { makeConfig, makeDiff } from "./helpers.js";

function buildReport(changedFiles: string[]) {
  const config = makeConfig({
    owners: [{ paths: ["src/api/**"], reviewers: ["@api-owner"] }],
  });
  const diff = makeDiff({ changedFiles });
  const deterministic = runRules({ config, diff, overlap: [] });
  return assembleReport({
    config,
    diff,
    overlap: [
      { number: 42, title: "Refactor types", overlappingFiles: ["src/api/routes.ts"] },
    ],
    deterministic: [
      ...deterministic,
      {
        id: "pr-overlap:42",
        title: "File overlap with PR #42",
        severity: "medium",
        category: "overlap",
        message: "Overlaps on src/api/routes.ts",
        files: ["src/api/routes.ts"],
      },
    ],
    semantic: { status: "absent" },
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("renderMarkdown", () => {
  it("includes the dedup marker and all key sections", () => {
    const report = buildReport(["src/api/routes.ts"]);
    const md = renderMarkdown(report);

    expect(md.startsWith(REPORT_MARKER)).toBe(true);
    expect(md).toContain("## PullStack PR Risk Report");
    expect(md).toContain("**Risk:**");
    expect(md).toContain("**Merge recommendation:**");
    expect(md).toContain("### Summary");
    expect(md).toContain("### Key Findings");
    expect(md).toContain("| Severity | Category | Finding |");
    expect(md).toContain("### Review Focus");
    expect(md).toContain("### Suggested Reviewers");
    expect(md).toContain("@api-owner");
    expect(md).toContain("### PR Overlap");
    expect(md).toContain("#42");
    expect(md).toContain("### Suggested Next Steps");
  });

  it("shows the risk score out of 100", () => {
    const report = buildReport(["src/api/routes.ts"]);
    const md = renderMarkdown(report);
    expect(md).toContain(`${report.risk.score} / 100`);
  });

  it("escapes pipe characters in finding messages", () => {
    const report = buildReport(["src/api/routes.ts"]);
    report.findings.push({
      id: "x",
      title: "weird",
      severity: "high",
      category: "size",
      message: "a | b | c",
    });
    const md = renderMarkdown(report);
    expect(md).toContain("a \\| b \\| c");
  });
});
