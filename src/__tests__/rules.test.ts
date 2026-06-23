import { describe, expect, it } from "vitest";
import {
  ruleLargePR,
  ruleMissingTests,
  ruleProtectedPath,
  ruleScopeAllowed,
  ruleScopeForbidden,
  ruleSharedContract,
  ruleOwnerReview,
  ruleOverlap,
  runRules,
} from "../analyzer/rules.js";
import { makeConfig, makeDiff } from "./helpers.js";
import type { PROverlap } from "../report/schema.js";

const ctx = (changedFiles: string[], extra: Record<string, unknown> = {}) => ({
  config: makeConfig(extra.config as Record<string, unknown> | undefined),
  diff: makeDiff({ changedFiles, ...(extra.diff as object) }),
  overlap: (extra.overlap as PROverlap[]) ?? [],
});

describe("ruleLargePR", () => {
  it("does not flag a small PR", () => {
    expect(ruleLargePR(ctx(["src/a.ts"]))).toHaveLength(0);
  });

  it("flags too many changed files", () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
    const findings = ruleLargePR(ctx(files));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("large-pr");
    expect(findings[0]!.severity).toBe("medium");
  });

  it("flags large added line counts as high severity when far over threshold", () => {
    const findings = ruleLargePR(
      ctx(["src/a.ts"], { diff: { totalAdded: 2000, totalDeleted: 0 } }),
    );
    expect(findings[0]!.severity).toBe("high");
  });
});

describe("ruleSharedContract", () => {
  it("flags changes to shared contract globs", () => {
    const findings = ruleSharedContract(ctx(["src/api/routes.ts", "src/util.ts"]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.files).toEqual(["src/api/routes.ts"]);
  });

  it("ignores unrelated files", () => {
    expect(ruleSharedContract(ctx(["src/util.ts"]))).toHaveLength(0);
  });
});

describe("ruleProtectedPath", () => {
  it("flags protected paths as critical for security/migrations", () => {
    const findings = ruleProtectedPath(ctx(["src/auth/login.ts"]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("critical");
  });

  it("flags a non-critical protected path as high", () => {
    const findings = ruleProtectedPath(
      ctx(["src/x.ts"], { config: { protected_paths: ["src/x.ts"] } }),
    );
    expect(findings[0]!.severity).toBe("high");
  });
});

describe("ruleMissingTests", () => {
  it("flags source changes with no test changes", () => {
    const findings = ruleMissingTests(ctx(["src/feature.ts"]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("missing-tests");
  });

  it("does not flag when a test file is included", () => {
    expect(
      ruleMissingTests(ctx(["src/feature.ts", "src/feature.test.ts"])),
    ).toHaveLength(0);
  });

  it("does not flag docs-only changes", () => {
    expect(ruleMissingTests(ctx(["README.md", "docs/guide.md"]))).toHaveLength(0);
  });
});

describe("ruleScopeAllowed", () => {
  it("is disabled when no allowed paths declared", () => {
    expect(ruleScopeAllowed(ctx(["anything.ts"]))).toHaveLength(0);
  });

  it("flags files outside the declared allowed scope", () => {
    const findings = ruleScopeAllowed(
      ctx(["src/in.ts", "other/out.ts"], {
        config: { scope: { declared_allowed_paths: ["src/**"] } },
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.files).toEqual(["other/out.ts"]);
  });
});

describe("ruleScopeForbidden", () => {
  it("flags forbidden path changes as critical", () => {
    const findings = ruleScopeForbidden(
      ctx(["src/secret/keys.ts"], {
        config: { scope: { declared_forbidden_paths: ["src/secret/**"] } },
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("critical");
  });
});

describe("ruleOwnerReview", () => {
  it("suggests reviewers for owned paths", () => {
    const findings = ruleOwnerReview(
      ctx(["src/auth/login.ts"], {
        config: {
          owners: [{ paths: ["src/auth/**"], reviewers: ["@sec"] }],
        },
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.category).toBe("ownership");
    expect(findings[0]!.message).toContain("@sec");
  });
});

describe("ruleOverlap", () => {
  it("creates one finding per overlapping PR", () => {
    const overlap: PROverlap[] = [
      { number: 42, title: "Other PR", overlappingFiles: ["src/types.ts"] },
    ];
    const findings = ruleOverlap(ctx(["src/types.ts"], { overlap }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("pr-overlap:42");
  });
});

describe("runRules", () => {
  it("aggregates findings from multiple rules", () => {
    const findings = runRules(ctx(["src/api/routes.ts"]));
    const ids = findings.map((f) => f.id);
    expect(ids).toContain("shared-contract");
    expect(ids).toContain("missing-tests");
  });
});
