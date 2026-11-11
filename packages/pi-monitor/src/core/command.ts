import type { LoadedMonitorConfig } from "./config.ts";
import type { MonitorRegistry, MonitorTask } from "./registry.ts";

export interface CommandResult {
  message: string;
  type: "info" | "warning" | "error";
}

export interface CommandRequest {
  args: string;
  registry: MonitorRegistry;
  now: number;
  /** The config as it is on disk now. */
  config: LoadedMonitorConfig;
  configFile: string;
}

interface Subcommand {
  name: string;
  usage: string;
  description: string;
}

const SUBCOMMANDS: readonly Subcommand[] = [
  { name: "list", usage: "list", description: "List the monitors that run now" },
  { name: "cancel", usage: "cancel <id|all>", description: "Stop a monitor, or all of them" },
  { name: "history", usage: "history", description: "List the monitors that ended" },
  { name: "status", usage: "status", description: "Show the config" },
];

const USAGE = SUBCOMMANDS.map((subcommand) => subcommand.usage).join("\n");

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

function elapsed(task: MonitorTask, now: number): string {
  return formatDuration((task.finishedAt ?? now) - task.startedAt);
}

function listRunning(request: CommandRequest): CommandResult {
  const running = request.registry.list().filter((task) => task.status === "running");
  if (running.length === 0) return { message: "No monitor is running.", type: "info" };
  return { message: running.map((task) => `${task.id}  ${elapsed(task, request.now)}  ${task.description}`).join("\n"), type: "info" };
}

function listEnded(request: CommandRequest): CommandResult {
  const ended = request.registry
    .list()
    .filter((task) => task.status !== "running")
    .reverse();
  if (ended.length === 0) return { message: "No monitor has ended in this session.", type: "info" };
  const lines = ended.map((task) => {
    const reason = task.detail === undefined ? "" : `\n    ${task.detail}`;
    return `${task.id}  ${task.status}  ${elapsed(task, request.now)}  ${task.description}${reason}`;
  });
  return { message: lines.join("\n"), type: "info" };
}

function cancel(request: CommandRequest, target: string): CommandResult {
  if (target === "") return { message: "Usage: cancel <id|all>", type: "error" };
  if (target === "all") {
    const running = request.registry.list().filter((task) => task.status === "running").length;
    if (running === 0) return { message: "No monitor is running.", type: "info" };
    request.registry.cancelAll();
    return { message: `Cancelled ${running} monitor${running === 1 ? "" : "s"}.`, type: "info" };
  }
  const problem = request.registry.cancel(target);
  return problem ? { message: problem, type: "error" } : { message: `Cancelled ${target}.`, type: "info" };
}

function status(request: CommandRequest): CommandResult {
  const running = request.registry.list().filter((task) => task.status === "running").length;
  const lines = [`monitors: ${running} running`];
  if ("errors" in request.config) {
    return { message: [...lines, `config ${request.configFile} is invalid, so no monitor starts:`, ...request.config.errors].join("\n"), type: "warning" };
  }
  const { maxMonitors, maxRuntimeMs, batchMs, maxLineChars, maxEventsPerMinute } = request.config.config;
  lines.push(
    `config: ${request.configFile}`,
    `maxMonitors: ${maxMonitors}`,
    `maxRuntimeMs: ${maxRuntimeMs}`,
    `batchMs: ${batchMs}`,
    `maxLineChars: ${maxLineChars}`,
    `maxEventsPerMinute: ${maxEventsPerMinute}`,
  );
  return { message: lines.join("\n"), type: "info" };
}

export function runCommand(request: CommandRequest): CommandResult {
  const [name = "", ...rest] = request.args.trim().split(/\s+/);
  if (name === "list") return listRunning(request);
  if (name === "history") return listEnded(request);
  if (name === "cancel") return cancel(request, rest.join(" "));
  if (name === "status" || name === "") return status(request);
  return { message: `Unknown subcommand "${name}". Use one of:\n${USAGE}`, type: "error" };
}
