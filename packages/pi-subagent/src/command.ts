import type { BackgroundRegistry, BackgroundTask } from "./background.ts";
import type { LoadedSubagentConfig } from "./config.ts";
import type { GuardPlan } from "./guard.ts";

export interface CommandResult {
  message: string;
  type: "info" | "warning" | "error";
}

export interface CommandRequest {
  args: string;
  registry: BackgroundRegistry;
  now: number;
  /** The config as it is on disk now. */
  config: LoadedSubagentConfig;
  configFile: string;
  guard: GuardPlan;
}

interface Subcommand {
  name: string;
  usage: string;
  description: string;
}

const SUBCOMMANDS: readonly Subcommand[] = [
  { name: "list", usage: "list", description: "List the background subagents that run now" },
  { name: "cancel", usage: "cancel <id|all>", description: "Stop a background subagent, or all of them" },
  { name: "history", usage: "history", description: "List the background subagents that finished" },
  { name: "status", usage: "status", description: "Show the config and whether pi-automode guards the subagents" },
];

const USAGE = SUBCOMMANDS.map((subcommand) => subcommand.usage).join("\n");
const MAX_ERROR_CHARS = 120;

export interface Completion {
  value: string;
  label: string;
  description?: string;
}

/** `value` replaces the whole argument text, so it repeats the words already typed. */
export function completeArguments(argumentText: string, runningIds: readonly string[]): Completion[] {
  const [first = "", ...rest] = argumentText.split(" ");
  if (rest.length === 0) {
    return SUBCOMMANDS.filter((subcommand) => subcommand.name.startsWith(first)).map((subcommand) => ({
      value: subcommand.name,
      label: subcommand.usage,
      description: subcommand.description,
    }));
  }
  if (first !== "cancel" || rest.length > 1) return [];
  const typed = rest[0] ?? "";
  return [...runningIds, "all"].filter((id) => id.startsWith(typed)).map((id) => ({ value: `cancel ${id}`, label: id }));
}

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function elapsed(task: BackgroundTask, now: number): string {
  return formatDuration((task.finishedAt ?? now) - task.startedAt);
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > MAX_ERROR_CHARS ? `${line.slice(0, MAX_ERROR_CHARS - 1)}…` : line;
}

function listRunning(request: CommandRequest): CommandResult {
  const running = request.registry.list().filter((task) => task.status === "running");
  if (running.length === 0) return { message: "No background subagent is running.", type: "info" };
  return { message: running.map((task) => `${task.id}  ${elapsed(task, request.now)}  ${task.summary}`).join("\n"), type: "info" };
}

function listFinished(request: CommandRequest): CommandResult {
  const finished = request.registry
    .list()
    .filter((task) => task.status !== "running")
    .reverse();
  if (finished.length === 0) return { message: "No background subagent has finished in this session.", type: "info" };
  const lines = finished.map((task) => {
    const reason = task.error === undefined ? "" : `\n    ${firstLine(task.error)}`;
    return `${task.id}  ${task.status}  ${elapsed(task, request.now)}  ${task.summary}${reason}`;
  });
  return { message: lines.join("\n"), type: "info" };
}

function cancel(request: CommandRequest, target: string): CommandResult {
  if (target === "") return { message: "Usage: cancel <id|all>", type: "error" };
  if (target === "all") {
    const running = request.registry.list().filter((task) => task.status === "running").length;
    if (running === 0) return { message: "No background subagent is running.", type: "info" };
    request.registry.cancelAll();
    return { message: `Cancelled ${running} background subagent${running === 1 ? "" : "s"}.`, type: "info" };
  }
  const problem = request.registry.cancel(target);
  return problem ? { message: problem, type: "error" } : { message: `Cancelled ${target}.`, type: "info" };
}

function describeGuard(guard: GuardPlan): string {
  if (guard.kind === "none") return "pi-automode: not installed, so subagents run without a guard";
  if (guard.kind === "invalid") return "pi-automode: its status cannot be read, so subagents are not started";
  return `pi-automode: guards subagents, mode ${guard.mode}${guard.classifierModel ? `, classifier ${guard.classifierModel}` : ""}`;
}

function status(request: CommandRequest): CommandResult {
  const running = request.registry.list().filter((task) => task.status === "running").length;
  const lines = [`background: ${running} running`, describeGuard(request.guard)];
  if ("errors" in request.config) {
    return { message: [...lines, `config ${request.configFile} is invalid, so no subagent starts:`, ...request.config.errors].join("\n"), type: "warning" };
  }
  const { stallTimeoutMs, model, maxStderrChars, maxBackground } = request.config.config;
  lines.push(
    `config: ${request.configFile}`,
    `stallTimeoutMs: ${stallTimeoutMs}`,
    `model: ${model ?? "(the model of the session)"}`,
    `maxStderrChars: ${maxStderrChars}`,
    `maxBackground: ${maxBackground}`,
  );
  return { message: lines.join("\n"), type: guardIsUsable(request.guard) ? "info" : "warning" };
}

function guardIsUsable(guard: GuardPlan): boolean {
  return guard.kind !== "invalid";
}

export function runCommand(request: CommandRequest): CommandResult {
  const [name = "", ...rest] = request.args.trim().split(/\s+/);
  if (name === "list") return listRunning(request);
  if (name === "history") return listFinished(request);
  if (name === "cancel") return cancel(request, rest.join(" "));
  if (name === "status" || name === "") return status(request);
  return { message: `Unknown subcommand "${name}". Use one of:\n${USAGE}`, type: "error" };
}
