import { getAgentDir, getShellConfig, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { completeArguments, runCommand } from "./command.ts";
import { configPath, loadMonitorConfig } from "./config.ts";
import { FOOTER_KEY, footerText } from "./footer.ts";
import { compileLineFilter } from "./lines.ts";
import { showMenu } from "./menu.ts";
import { launchMonitor } from "./monitor.ts";
import { MonitorRegistry, type MonitorTask } from "./registry.ts";

const Parameters = Type.Object({
  command: Type.String({
    description:
      "A shell command that keeps running and prints one line per event, for example `tail -f app.log | grep --line-buffered ERROR`. " +
      "Use `--line-buffered` (grep) or an equivalent when you pipe, or the lines arrive late.",
  }),
  description: Type.String({ description: "A short phrase that says what you watch for. It is shown in lists and in every message." }),
  include: Type.Optional(Type.String({ description: "Regex. Only lines that match are sent to you." })),
  exclude: Type.Optional(Type.String({ description: "Regex. Lines that match are not sent to you." })),
  includeStderr: Type.Optional(Type.Boolean({ description: "Also send what the command prints on stderr. Default: false." })),
});

const IdParameters = Type.Object({ id: Type.String({ description: "The id of a monitor, such as mon-1." }) });

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function describeList(tasks: MonitorTask[]): string {
  if (tasks.length === 0) return "No monitors in this session.";
  return tasks.map((task) => `${task.id}  ${task.status}  ${task.description}`).join("\n");
}

export default function (pi: ExtensionAPI): void {
  // The registry reports from callbacks that have no context, so the ui of the session is kept here.
  let footerUi: ExtensionContext["ui"] | undefined;
  let running = 0;

  function refreshFooter(): void {
    try {
      footerUi?.setStatus(FOOTER_KEY, footerText(running));
    } catch {
      // A footer that cannot be drawn must not stop a monitor.
    }
  }

  const registry = new MonitorRegistry({
    maxRunning: 1,
    onChange: (runningCount) => {
      running = runningCount;
      refreshFooter();
    },
  });

  function cancelAllAndClearFooter(): void {
    registry.cancelAll();
    try {
      footerUi?.setStatus(FOOTER_KEY, undefined);
    } catch {
      // The ui may be gone already.
    }
    footerUi = undefined;
  }

  function sendToModel(text: string, task: MonitorTask): void {
    pi.sendMessage(
      { customType: "monitor-event", content: text, display: true, details: { id: task.id, status: task.status } },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  function startMonitor(params: Static<typeof Parameters>, context: ExtensionContext) {
    // Without a UI nobody is there to receive the output: pi may end before the command does.
    if (!context.hasUI) throw new Error("A monitor needs an interactive session.");

    // Read on every call, so an edit applies at once. An invalid file stops the monitor: the user's intent is unclear.
    const loaded = loadMonitorConfig(configPath(getAgentDir()));
    if ("errors" in loaded) throw new Error(`The monitor was not started because its config is invalid:\n${loaded.errors.join("\n")}`);

    const filter = compileLineFilter({ include: params.include, exclude: params.exclude });
    if ("error" in filter) throw new Error(filter.error);

    const shell = getShellConfig();
    if (shell.commandTransport === "stdin") throw new Error("This shell reads its command from stdin, which pi-monitor does not support.");

    registry.setMaxRunning(loaded.config.maxMonitors);
    const launched = launchMonitor({
      registry,
      command: params.command,
      description: params.description,
      cwd: context.cwd,
      shell: { path: shell.shell, args: shell.args },
      config: loaded.config,
      filter,
      includeStderr: params.includeStderr ?? false,
      send: sendToModel,
    });
    if ("refusal" in launched) throw new Error(launched.refusal);
    return textResult(`Started monitor ${launched.task.id}. Its output will arrive later as new messages, and a last message when it ends.`);
  }

  pi.registerTool({
    name: "monitor",
    label: "Monitor",
    description:
      "Run a long-lived shell command in the background and get each batch of its output lines as a new message, which wakes you. " +
      "Use it to wait for an event without polling, for example a log line, a build result or a file change. " +
      "The command is stopped when it ends, when it prints too many lines, when it runs too long, or when the user cancels it. " +
      "Filter in the command or with include/exclude: every line that reaches you costs a turn.",
    parameters: Parameters,
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      return startMonitor(params, context);
    },
  });

  pi.registerTool({
    name: "monitor_list",
    label: "Monitor list",
    description: "List the monitors of this session and their status.",
    parameters: Type.Object({}),
    async execute() {
      return textResult(describeList(registry.list()));
    },
  });

  pi.registerTool({
    name: "monitor_cancel",
    label: "Monitor cancel",
    description: "Stop a running monitor. No more output arrives for it.",
    parameters: IdParameters,
    async execute(_toolCallId, params) {
      const problem = registry.cancel(params.id);
      if (problem) throw new Error(problem);
      return textResult(`Cancelled ${params.id}.`);
    },
  });

  const runningIds = () =>
    registry
      .list()
      .filter((task) => task.status === "running")
      .map((task) => task.id);

  // A cancelled monitor sends nothing, so without this note the model would wait for output that never comes.
  function tellModelAboutCancels(runningBefore: string[]): void {
    const stillRunning = new Set(runningIds());
    const cancelled = runningBefore.filter((id) => !stillRunning.has(id) && registry.list().find((task) => task.id === id)?.status === "cancelled");
    if (cancelled.length === 0) return;
    pi.sendMessage(
      { customType: "monitor-event", content: `The user cancelled ${cancelled.join(", ")}. No more output will arrive.`, display: true, details: { ids: cancelled, status: "cancelled" } },
      { deliverAs: "followUp" },
    );
  }

  // Without arguments, a person uses a menu. An empty list means the person closed it.
  async function commandsFromMenu(context: Pick<ExtensionContext, "mode" | "ui">): Promise<string[]> {
    // Only the terminal can draw a custom component. RPC mode has a UI that cannot.
    if (context.mode !== "tui") return ["status", "list"];
    return showMenu(context.ui, () => registry.list());
  }

  pi.registerCommand("monitor", {
    description: "Manage monitors: list, cancel, history, status",
    getArgumentCompletions: (argumentText) => completeArguments(argumentText, runningIds()),
    handler: async (args, context) => {
      const commands = args.trim() === "" ? await commandsFromMenu(context) : [args];
      for (const command of commands) {
        const runningBefore = runningIds();
        const result = runCommand({
          args: command,
          registry,
          now: Date.now(),
          config: loadMonitorConfig(configPath(getAgentDir())),
          configFile: configPath(getAgentDir()),
        });
        context.ui.notify(result.message, result.type);
        tellModelAboutCancels(runningBefore);
      }
    },
  });

  pi.on("session_start", (_event, context) => {
    footerUi = context.ui;
    refreshFooter();
  });

  // After the session ends no output can be delivered, so a command that goes on would only waste work.
  pi.on("session_shutdown", cancelAllAndClearFooter);
  // A switch or fork can still fail after these events, and then no session_start follows. So they must keep the footer.
  pi.on("session_before_switch", () => registry.cancelAll());
  pi.on("session_before_fork", () => registry.cancelAll());
}
