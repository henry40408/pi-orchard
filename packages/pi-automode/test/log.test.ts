import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DecisionLog, logFileName, pruneOldLogs, type LogEntry } from "../src/log.ts";

const entry = (overrides: Partial<LogEntry> = {}): LogEntry => ({
  cwd: "/work",
  toolName: "bash",
  input: { command: "make" },
  action: "allow",
  source: "rule",
  reason: "ok",
  child: false,
  ...overrides,
});

const settings = { maxFileBytes: 1_048_576 };
const readLines = (file: string) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("logFileName", () => {
  it("starts with the time so the files sort by time", () => {
    assert.equal(logFileName(new Date("2026-10-22T12:30:05.123Z"), "ab12cd34-ef56"), "2026-10-22T12-30-05Z-ab12cd34.jsonl");
  });

  it("keeps odd characters of a session id out of the name", () => {
    assert.match(logFileName(new Date(), "../../x y"), /^[\w.-]+\.jsonl$/);
  });
});

describe("DecisionLog", () => {
  const newLog = () => new DecisionLog(join(mkdtempSync(join(tmpdir(), "automode-log-")), "logs", "a.jsonl"));

  it("appends one JSON line per decision, with the whole input", () => {
    const log = newLog();
    log.write(entry(), settings, new Date("2026-10-22T00:00:00Z"));
    log.write(entry({ toolName: "read", input: { path: "a" }, answer: "allowed" }), settings);
    const lines = readLines(log.file);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.time, "2026-10-22T00:00:00.000Z");
    assert.deepEqual(lines[0]?.input, { command: "make" });
    assert.equal(lines[1]?.answer, "allowed");
  });

  it("creates the file with owner-only permissions", () => {
    const log = newLog();
    log.write(entry(), settings);
    assert.equal(statSync(log.file).mode & 0o777, 0o600);
  });

  it("cuts a huge entry down to one small line and marks it", () => {
    const log = newLog();
    log.write(entry({ input: { command: "x".repeat(500_000) }, classifier: { system: "s", user: "u", reply: "r" } }), settings);
    const [line] = readLines(log.file);
    assert.equal(line?.truncated, true);
    assert.equal(line?.classifier, undefined);
    assert.ok(readFileSync(log.file, "utf8").length < 70_000);
  });

  it("writes an input that cannot be turned into JSON", () => {
    const log = newLog();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    log.write(entry({ input: circular }), settings);
    assert.equal(readLines(log.file)[0]?.input, "(input cannot be shown)");
  });

  it("moves a file that grew past the limit to .1 and starts a new one", () => {
    const log = newLog();
    log.write(entry({ reason: "first" }), { maxFileBytes: 100 });
    log.write(entry({ reason: "second" }), { maxFileBytes: 100 });
    log.write(entry({ reason: "third" }), { maxFileBytes: 100 });
    assert.equal(readLines(`${log.file}.1`)[0]?.reason, "second");
    assert.deepEqual(readLines(log.file).map((line) => line.reason), ["third"]);
  });

  it("does not throw when it cannot write, and remembers the first failure", () => {
    const blocker = join(mkdtempSync(join(tmpdir(), "automode-log-")), "file");
    writeFileSync(blocker, "");
    const log = new DecisionLog(join(blocker, "inside", "a.jsonl"));
    log.write(entry(), settings);
    assert.ok(log.failure);
    const first = log.failure;
    log.write(entry(), settings);
    assert.equal(log.failure, first);
  });
});

describe("pruneOldLogs", () => {
  const now = new Date("2026-10-22T00:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;

  function directoryWith(files: Array<{ name: string; ageDays: number }>) {
    const directory = mkdtempSync(join(tmpdir(), "automode-prune-"));
    for (const { name, ageDays } of files) {
      const path = join(directory, name);
      writeFileSync(path, "{}\n");
      const modified = new Date(now.getTime() - ageDays * DAY);
      utimesSync(path, modified, modified);
    }
    return directory;
  }
  const name = (day: number) => `2026-10-${String(day).padStart(2, "0")}T00-00-00Z-aaaa.jsonl`;

  it("deletes files older than keepDays, but not the current one", () => {
    const directory = directoryWith([
      { name: name(1), ageDays: 20 },
      { name: name(2), ageDays: 30 },
      { name: name(20), ageDays: 2 },
    ]);
    const deleted = pruneOldLogs({ directory, keepDays: 14, keepFiles: 100, currentFile: join(directory, name(2)), now });
    assert.equal(deleted, 1);
    assert.deepEqual(readdirSync(directory).sort(), [name(2), name(20)]);
  });

  it("keeps the newest files when there are more than keepFiles", () => {
    const directory = directoryWith([
      { name: name(10), ageDays: 5 },
      { name: name(11), ageDays: 4 },
      { name: name(12), ageDays: 3 },
      { name: name(13), ageDays: 2 },
    ]);
    pruneOldLogs({ directory, keepDays: 365, keepFiles: 3, currentFile: join(directory, name(14)), now });
    assert.deepEqual(readdirSync(directory).sort(), [name(12), name(13)]);
  });

  it("deletes only files whose names look like log files", () => {
    const directory = directoryWith([
      { name: "notes.txt", ageDays: 400 },
      { name: "2026-10-01T00-00-00Z-aaaa.jsonl.1", ageDays: 400 },
      { name: "2026-10-01T00-00-00Z-aaaa.jsonl", ageDays: 400 },
    ]);
    pruneOldLogs({ directory, keepDays: 14, keepFiles: 100, currentFile: join(directory, "none"), now });
    assert.deepEqual(readdirSync(directory), ["notes.txt"]);
  });

  it("does nothing when the directory does not exist", () => {
    assert.equal(pruneOldLogs({ directory: join(tmpdir(), "automode-no-such-dir"), keepDays: 1, keepFiles: 1, currentFile: "x" }), 0);
    assert.equal(existsSync(join(tmpdir(), "automode-no-such-dir")), false);
  });
});
