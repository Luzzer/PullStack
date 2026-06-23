import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { ConfigSchema } from "../report/schema.js";

describe("config defaulting", () => {
  it("fills sensible defaults for an empty config", () => {
    const config = ConfigSchema.parse({});
    expect(config.project.name).toBe("project");
    expect(config.project.default_base).toBe("origin/main");
    expect(config.risk.large_pr_changed_files).toBe(20);
    expect(config.risk.large_pr_added_lines).toBe(800);
    expect(config.shared_contracts).toContain("src/types.ts");
    expect(config.protected_paths).toContain("src/auth/**");
    expect(config.owners).toEqual([]);
    expect(config.scope.declared_allowed_paths).toEqual([]);
  });

  it("merges partial config over defaults", () => {
    const config = ConfigSchema.parse({
      project: { name: "my-app" },
      risk: { large_pr_changed_files: 5 },
    });
    expect(config.project.name).toBe("my-app");
    expect(config.project.default_base).toBe("origin/main"); // default kept
    expect(config.risk.large_pr_changed_files).toBe(5);
    expect(config.risk.large_pr_added_lines).toBe(800); // default kept
  });

  it("throws for an explicitly-specified missing config file", () => {
    expect(() =>
      loadConfig(join(tmpdir(), "definitely-missing-pullstack-XYZ.yml")),
    ).toThrow(/not found/);
  });

  it("returns defaults when no config path is given and none is present", () => {
    // No argument -> looks for .pullstack.yml in cwd (the repo root has only
    // .pullstack.example.yml), so defaults are returned.
    const config = loadConfig();
    expect(config.project.default_base).toBe("origin/main");
  });

  it("loads and validates a YAML file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pullstack-cfg-"));
    const file = join(dir, ".pullstack.yml");
    writeFileSync(
      file,
      "project:\n  name: yaml-app\nrisk:\n  large_pr_changed_files: 3\n",
      "utf8",
    );
    const config = loadConfig(file);
    expect(config.project.name).toBe("yaml-app");
    expect(config.risk.large_pr_changed_files).toBe(3);
  });

  it("throws a readable error for an invalid config type", () => {
    const dir = mkdtempSync(join(tmpdir(), "pullstack-bad-"));
    const file = join(dir, ".pullstack.yml");
    writeFileSync(file, "risk:\n  large_pr_changed_files: not-a-number\n", "utf8");
    expect(() => loadConfig(file)).toThrow(/Invalid config/);
  });
});
