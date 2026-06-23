import { ConfigSchema, type Config, type DiffData, type FileStat } from "../report/schema.js";

export function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse(overrides);
}

export function makeDiff(opts: Partial<DiffData> & { changedFiles?: string[] }): DiffData {
  const changedFiles = opts.changedFiles ?? [];
  const stats: FileStat[] =
    opts.stats ?? changedFiles.map((file) => ({ file, added: 1, deleted: 0 }));
  const totalAdded =
    opts.totalAdded ?? stats.reduce((sum, s) => sum + s.added, 0);
  const totalDeleted =
    opts.totalDeleted ?? stats.reduce((sum, s) => sum + s.deleted, 0);
  return {
    base: opts.base ?? "origin/main",
    head: opts.head ?? "HEAD",
    changedFiles,
    stats,
    totalAdded,
    totalDeleted,
    diffText: opts.diffText ?? "",
  };
}
