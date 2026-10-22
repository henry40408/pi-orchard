import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config/schema.ts";

/**
 * A parent pi sets this for a child pi, so both write to one file. It is the
 * path of the parent's log file; pi-subagent passes it on.
 */
export const LOG_FILE_ENV = "PI_AUTOMODE_LOG_FILE";

export type LogSettings = Config["log"];

/** One decision, as written to the log. The time and the `child` mark are added when it is written. */
export interface LogEntry {
  cwd: string;
  toolName: string;
  /** The whole input: a cut-down copy could hide what actually ran. */
  input: unknown;
  action: string;
  source: string;
  reason: string;
  answer?: string;
  child: boolean;
  /** Only with `log.classifierIo`. */
  classifier?: { system: string; user: string; reply: string };
}

const LOG_DIRECTORY = "automode-logs";
const ROTATED_SUFFIX = ".1";
// One line must stay small, or a single huge input could fill the disk.
const MAX_LINE_CHARS = 64 * 1024;
const TRUNCATED_INPUT_CHARS = 8000;
const TRUNCATED_REASON_CHARS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Only files with this name are ever deleted.
const LOG_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[\w-]+\.jsonl(\.1)?$/;

export function logDirectory(agentDir: string): string {
  return join(agentDir, LOG_DIRECTORY);
}

/** The start time comes first, so the files sort by time. */
export function logFileName(start: Date, sessionId: string): string {
  const time = start.toISOString().slice(0, 19).replaceAll(":", "-");
  const id = sessionId.replace(/[^\w-]/g, "").slice(0, 8);
  return `${time}Z-${id || "session"}.jsonl`;
}

function stringifyEntry(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record);
  } catch {
    // A circular or BigInt input must not stop the log.
    return JSON.stringify({ ...record, input: "(input cannot be shown)" });
  }
}

function serializeEntry(record: Record<string, unknown>): string {
  const line = stringifyEntry(record);
  if (line.length <= MAX_LINE_CHARS) return line;
  const { classifier: _dropped, input, reason, ...rest } = record;
  const inputText = typeof input === "string" ? input : (stringifyEntry({ input }) ?? "");
  return stringifyEntry({
    ...rest,
    input: inputText.slice(0, TRUNCATED_INPUT_CHARS),
    reason: typeof reason === "string" ? reason.slice(0, TRUNCATED_REASON_CHARS) : reason,
    truncated: true,
  });
}

/** Appends one JSON line per decision to one file. It never throws: a log failure must not change a decision. */
export class DecisionLog {
  #file: string;
  /** The first write error, for `/automode status`. */
  failure: string | undefined;

  constructor(file: string) {
    this.#file = file;
  }

  get file(): string {
    return this.#file;
  }

  write(entry: LogEntry, settings: Pick<LogSettings, "maxFileBytes">, now = new Date()): void {
    try {
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      this.#rotateIfLarge(settings.maxFileBytes);
      appendFileSync(this.#file, `${serializeEntry({ time: now.toISOString(), ...entry })}\n`, { mode: 0o600 });
    } catch (error) {
      this.failure ??= error instanceof Error ? error.message : String(error);
    }
  }

  // The rename can fail when another process rotated first; the append then still works.
  #rotateIfLarge(maxFileBytes: number): void {
    let size: number;
    try {
      size = statSync(this.#file).size;
    } catch {
      return;
    }
    if (size <= maxFileBytes) return;
    try {
      renameSync(this.#file, `${this.#file}${ROTATED_SUFFIX}`);
    } catch {
      // Ignored on purpose.
    }
  }
}

export interface PruneRequest {
  directory: string;
  keepDays: number;
  keepFiles: number;
  /** The file of this session, which is never deleted. */
  currentFile: string;
  now?: Date;
}

/** Deletes old log files, and the oldest ones beyond `keepFiles`. Returns how many it deleted. */
export function pruneOldLogs(request: PruneRequest): number {
  const { directory, keepDays, keepFiles, currentFile, now = new Date() } = request;
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => LOG_FILE_PATTERN.test(name));
  } catch {
    return 0;
  }
  const files = names
    .map((name) => join(directory, name))
    .filter((path) => path !== currentFile && path !== `${currentFile}${ROTATED_SUFFIX}`)
    .flatMap((path) => {
      try {
        return [{ path, modified: statSync(path).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((first, second) => second.modified - first.modified);

  const cutoff = now.getTime() - keepDays * DAY_MS;
  // The current file counts toward the limit, so one slot is already taken.
  const room = Math.max(keepFiles - 1, 0);
  let deleted = 0;
  files.forEach((file, index) => {
    if (file.modified >= cutoff && index < room) return;
    try {
      unlinkSync(file.path);
      deleted += 1;
    } catch {
      // A file that cannot be deleted stays; the next session tries again.
    }
  });
  return deleted;
}
