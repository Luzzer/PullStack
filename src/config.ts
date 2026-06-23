import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, type Config } from "./report/schema.js";

export const DEFAULT_CONFIG_PATH = ".pullstack.yml";

/**
 * Load and validate a PullStack config file.
 *
 * - If `path` is provided and the file is missing, that is an error.
 * - If `path` is undefined, `.pullstack.yml` is used when present, otherwise
 *   built-in defaults are returned.
 * - Validation errors throw with a readable message.
 */
export function loadConfig(path?: string): Config {
  const explicit = path !== undefined;
  const resolved = path ?? DEFAULT_CONFIG_PATH;

  if (!existsSync(resolved)) {
    if (explicit) {
      throw new Error(`Config file not found: ${resolved}`);
    }
    // No config at all -> defaults.
    return ConfigSchema.parse({});
  }

  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch (err) {
    throw new Error(`Could not read config ${resolved}: ${(err as Error).message}`);
  }

  let data: unknown;
  try {
    data = parseYaml(raw) ?? {};
  } catch (err) {
    throw new Error(`Invalid YAML in ${resolved}: ${(err as Error).message}`);
  }

  const parsed = ConfigSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config in ${resolved}:\n${issues}`);
  }

  return parsed.data;
}
