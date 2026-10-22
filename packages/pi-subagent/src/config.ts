import { readFileSync } from "node:fs";
import { join } from "node:path";
import Type from "typebox";
import Value from "typebox/value";

export interface SubagentConfig {
  /** A child that prints nothing for this long is killed. */
  stallTimeoutMs: number;
  /** The model of a subagent when the model did not ask for one. Unset means the model of this session. */
  model: string | undefined;
  /** How much of the end of the child's stderr is kept. */
  maxStderrChars: number;
}

export const DEFAULT_CONFIG: SubagentConfig = { stallTimeoutMs: 600_000, model: undefined, maxStderrChars: 20_000 };

// additionalProperties: false makes a misspelled key an error instead of silently doing nothing.
const ConfigFileSchema = Type.Object(
  {
    stallTimeoutMs: Type.Optional(Type.Integer({ minimum: 10_000, maximum: 3_600_000 })),
    model: Type.Optional(Type.String({ pattern: "^[^/\\s]+/\\S+$" })),
    maxStderrChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 1_000_000 })),
  },
  { additionalProperties: false },
);

export type LoadedSubagentConfig = { config: SubagentConfig } | { errors: string[] };

export function configPath(agentDir: string): string {
  return join(agentDir, "subagent.json");
}

/** A missing file means the defaults. An invalid file is an error: the caller must not start a subagent. */
export function loadSubagentConfig(path: string): LoadedSubagentConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: DEFAULT_CONFIG };
    return { errors: [`${path}: ${(error as Error).message}`] };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { errors: [`${path}: ${(error as Error).message}`] };
  }

  if (!Value.Check(ConfigFileSchema, json)) {
    return { errors: [...Value.Errors(ConfigFileSchema, json)].map((error) => `${path}: ${error.instancePath || "/"} ${error.message}`) };
  }
  return { config: { ...DEFAULT_CONFIG, ...json } };
}
