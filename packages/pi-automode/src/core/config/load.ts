import { readFileSync, statSync } from "node:fs";
import Value from "typebox/value";
import { resolveConfig } from "./defaults.ts";
import { applyProjectConfig } from "./merge.ts";
import { type Config, type ConfigFile, ConfigFileSchema } from "./schema.ts";

type ReadResult =
  | { status: "missing" }
  | { status: "ok"; file: ConfigFile }
  | { status: "invalid"; errors: string[] };

export interface LoadedConfig {
  config: Config;
  /** Non-empty when a config file is invalid; mode is then forced to "ask". */
  errors: string[];
  /** Project-layer fields that were ignored; the user should be told. */
  ignored: string[];
}

// The project file comes from an untrusted repo: a FIFO, or a symlink to
// /dev/zero, would make readFileSync hang.
const MAX_CONFIG_BYTES = 1024 * 1024;

// Deny rules in an invalid file do not apply either; the user must know.
const UNUSED_RULES_NOTICE = (path: string) =>
  `${path}: file is invalid, so none of its rules (including deny) are in effect; mode is forced to ask`;

export function readConfigFile(path: string): ReadResult {
  let text: string;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return { status: "invalid", errors: [`${path}: not a regular file`] };
    if (stats.size > MAX_CONFIG_BYTES) {
      return { status: "invalid", errors: [`${path}: file is larger than ${MAX_CONFIG_BYTES} bytes`] };
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "invalid", errors: [`${path}: ${(error as Error).message}`] };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { status: "invalid", errors: [`${path}: ${(error as Error).message}`] };
  }

  if (Value.Check(ConfigFileSchema, json)) return { status: "ok", file: json };
  const errors = [...Value.Errors(ConfigFileSchema, json)].map(
    (error) => `${path}: ${error.instancePath || "/"} ${error.message}`,
  );
  return { status: "invalid", errors };
}

export function loadConfig(paths: { user: string; project: string }): LoadedConfig {
  const errors: string[] = [];
  const user = readConfigFile(paths.user);
  const project = readConfigFile(paths.project);
  if (user.status === "invalid") errors.push(...user.errors, UNUSED_RULES_NOTICE(paths.user));
  if (project.status === "invalid") {
    errors.push(...project.errors, UNUSED_RULES_NOTICE(paths.project));
  }

  let config = resolveConfig(user.status === "ok" ? user.file : {});
  let ignored: string[] = [];
  if (project.status === "ok") ({ config, ignored } = applyProjectConfig(config, project.file));

  // When the user's intent is unclear, ask about everything.
  if (errors.length > 0) config.mode = "ask";
  return { config, errors, ignored };
}
