import { readFileSync } from "node:fs";
import { join } from "node:path";
import Type from "typebox";
import Value from "typebox/value";

export interface MonitorConfig {
  /** How many monitors may run at the same time. */
  maxMonitors: number;
  /** A monitor that runs longer is stopped. */
  maxRuntimeMs: number;
  /** Lines that arrive within this time are sent to the model as one message. */
  batchMs: number;
  /** A longer line is cut. */
  maxLineChars: number;
  /** A monitor that sends more lines than this in one minute is stopped. */
  maxEventsPerMinute: number;
}

export const DEFAULT_CONFIG: MonitorConfig = {
  maxMonitors: 4,
  maxRuntimeMs: 3_600_000,
  batchMs: 1000,
  maxLineChars: 500,
  maxEventsPerMinute: 120,
};

// additionalProperties: false makes a misspelled key an error instead of silently doing nothing.
const ConfigFileSchema = Type.Object(
  {
    maxMonitors: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
    maxRuntimeMs: Type.Optional(Type.Integer({ minimum: 10_000, maximum: 86_400_000 })),
    batchMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60_000 })),
    maxLineChars: Type.Optional(Type.Integer({ minimum: 80, maximum: 10_000 })),
    maxEventsPerMinute: Type.Optional(Type.Integer({ minimum: 1, maximum: 6000 })),
  },
  { additionalProperties: false },
);

export type LoadedMonitorConfig = { config: MonitorConfig } | { errors: string[] };

export function configPath(agentDir: string): string {
  return join(agentDir, "monitor.json");
}

/** A missing file means the defaults. An invalid file is an error: the caller must not start a monitor. */
export function loadMonitorConfig(path: string): LoadedMonitorConfig {
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
