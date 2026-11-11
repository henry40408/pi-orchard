import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config/schema.ts";
import type { Outcome } from "./decide.ts";
import { summarizeInput, type DecisionRecord, type UserAnswer } from "./history.ts";

/**
 * A parent pi sets this for a child pi, so both write to one file. It is the
 * path of the parent's log file; pi-subagent passes it on.
 */
export const LOG_FILE_ENV = "PI_AUTOMODE_LOG_FILE";

/** A parent pi sets this to `1` or `0` for a child pi: the child logs when the parent does. */
export const LOG_ENABLED_ENV = "PI_AUTOMODE_LOG_ENABLED";

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

// The end of the id: pi makes UUIDv7 ids, whose start is a timestamp that is the same for every session of the same minute.
function fileIdOfSession(sessionId: string): string {
  return sessionId.replace(/[^\w-]/g, "").slice(-12) || "session";
}

/** The start time comes first, so the files sort by time. */
export function logFileName(start: Date, sessionId: string): string {
  const time = start.toISOString().slice(0, 19).replaceAll(":", "-");
  return `${time}Z-${fileIdOfSession(sessionId)}.jsonl`;
}

/** The log files of one session, oldest first. Each start of a resumed session has its own file. */
export function sessionLogFiles(directory: string, sessionId: string): string[] {
  const ending = `-${fileIdOfSession(sessionId)}.jsonl`;
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => LOG_FILE_PATTERN.test(name) && name.replace(/\.1$/, "").endsWith(ending));
  } catch {
    return [];
  }
  // A rotated file (`.1`) holds older lines than the file with the same name.
  const sortKey = (name: string) => (name.endsWith(ROTATED_SUFFIX) ? `${name.slice(0, -ROTATED_SUFFIX.length)}\u0000` : `${name}\u0001`);
  return names.sort((first, second) => (sortKey(first) < sortKey(second) ? -1 : 1)).map((name) => join(directory, name));
}

const ACTIONS: readonly string[] = ["allow", "ask", "block"];
const ANSWERS: readonly string[] = ["allowed", "denied", "no-ui"];

function recordFromLogLine(line: string): DecisionRecord | undefined {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // The last line may be half written by another process.
    return undefined;
  }
  const { time, toolName, input, action, source, reason, answer, child } = entry;
  if (typeof time !== "string" || typeof toolName !== "string") return undefined;
  if (typeof action !== "string" || !ACTIONS.includes(action)) return undefined;
  if (typeof source !== "string" || typeof reason !== "string") return undefined;
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return undefined;
  return {
    time: date,
    toolName,
    summary: summarizeInput(input),
    outcome: { action, source, reason } as Outcome,
    ...(typeof answer === "string" && ANSWERS.includes(answer) && { answer: answer as UserAnswer }),
    ...(child === true && { child }),
  };
}

// Only the end of a file is read: it holds the newest lines, and a file can be as large as `maxFileBytes`.
const MAX_READ_BYTES = 4 * 1024 * 1024;

function readEndOfFile(file: string): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    const size = statSync(file).size;
    const start = Math.max(0, size - MAX_READ_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(descriptor, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    // A cut start leaves half a line, which would not parse.
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** The newest `count` decisions in these files, newest last. Unreadable files and lines are skipped. */
export function readLoggedDecisions(files: string[], count: number): DecisionRecord[] {
  if (count <= 0) return [];
  const records: DecisionRecord[] = [];
  for (const file of files) {
    const text = readEndOfFile(file);
    if (text === undefined) continue;
    for (const line of text.split("\n")) {
      const record = line === "" ? undefined : recordFromLogLine(line);
      if (record) records.push(record);
    }
  }
  return records.slice(-count);
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
