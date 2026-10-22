import { existsSync } from "node:fs";
import { basename } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { BackgroundRegistry, type BackgroundOutcome, type BackgroundTask } from "./background.ts";
import { completeArguments, runCommand } from "./command.ts";
import { FOOTER_KEY, footerText } from "./footer.ts";
import { showMenu } from "./menu.ts";
import { queryGuard } from "./guard.ts";
import { configPath, DEFAULT_CONFIG, loadSubagentConfig, type SubagentConfig } from "./config.ts";
import { buildLaunch, CHILD_ENV } from "./launch.ts";
import { formatBackgroundResult } from "./result-message.ts";
import { runChild, type RunResult } from "./run.ts";

/** Runs the same pi that runs this extension, so the child is the same version. */
function piCommand(): { command: string; prefixArgs: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
    return { command: process.execPath, prefixArgs: [script] };
  }
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(basename(process.execPath).toLowerCase());
  return isGenericRuntime ? { command: "pi", prefixArgs: [] } : { command: process.execPath, prefixArgs: [] };
}

const Parameters = Type.Object({
  task: Type.String({ description: "What the subagent should do. It sees nothing of this conversation, so say everything it needs." }),
  model: Type.Optional(
    Type.String({ description: "Model for the subagent, as provider/id. Default: the current model. While pi-automode is active, its classifier still checks the subagent's tool calls." }),
  ),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Allowlist of tool names for the subagent. Default: all." })),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Start the subagent and return at once. Its answer arrives later as a new message. Use it for work you do not need right now. Default: false.",
    }),
  ),
});

const IdParameters = Type.Object({ id: Type.String({ description: "The id of a background subagent, such as bg-1." }) });

interface ChildSettings {
  config: SubagentConfig;
  command: string;
  args: string[];
  environment: Record<string, string | undefined>;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function outcomeOf(result: RunResult): BackgroundOutcome {
  if (result.failure) return { text: "", error: result.failure };
  if (result.exitCode !== 0) return { text: "", error: `The subagent exited with code ${result.exitCode}: ${result.stderr.trim()}` };
  return { text: result.text || "(the subagent returned no text)" };
}

function describeList(tasks: BackgroundTask[]): string {
  if (tasks.length === 0) return "No background subagents in this session.";
  return tasks.map((task) => `${task.id}  ${task.status}  ${task.summary}`).join("\n");
}

export default function (pi: ExtensionAPI): void {
  if (process.env[CHILD_ENV]) return;

  // The registry reports from callbacks that have no context, so the ui of the session is kept here.
  let footerUi: ExtensionContext["ui"] | undefined;
  let backgroundRunning = 0;
  let foregroundRunning = 0;

  function refreshFooter(): void {
    try {
      footerUi?.setStatus(FOOTER_KEY, footerText(backgroundRunning + foregroundRunning));
    } catch {
      // A footer that cannot be drawn must not stop a subagent.
    }
  }

  const background = new BackgroundRegistry({
    maxRunning: DEFAULT_CONFIG.maxBackground,
    onChange: (runningCount) => {
      backgroundRunning = runningCount;
      refreshFooter();
    },
  });

  /** Counts a subagent that the model waits for, so the footer shows it too. */
  async function countingForeground<T>(work: () => Promise<T>): Promise<T> {
    foregroundRunning += 1;
    refreshFooter();
    try {
      return await work();
    } finally {
      foregroundRunning -= 1;
      refreshFooter();
    }
  }

  function cancelAllAndClearFooter(): void {
    background.cancelAll();
    try {
      footerUi?.setStatus(FOOTER_KEY, undefined);
    } catch {
      // The ui may be gone already.
    }
    footerUi = undefined;
  }

  // Read on every call, so an edit applies at once. An invalid file stops the subagent: the user's intent is unclear.
  function prepareChild(params: Static<typeof Parameters>, context: ExtensionContext): ChildSettings {
    const loaded = loadSubagentConfig(configPath(getAgentDir()));
    if ("errors" in loaded) {
      throw new Error(`The subagent was not started because its config is invalid:\n${loaded.errors.join("\n")}`);
    }
    const { config } = loaded;

    const guard = queryGuard(pi.events);
    if (guard.kind === "invalid") {
      throw new Error("pi-automode answered with a status that pi-subagent cannot read. The subagent was not started.");
    }

    const parentModel = context.model ? `${context.model.provider}/${context.model.id}` : undefined;
    const launch = buildLaunch({
      task: params.task,
      guard,
      requestedModel: params.model,
      parentModel,
      defaultModel: config.model,
      tools: params.tools,
      environment: process.env,
    });
    const { command, prefixArgs } = piCommand();
    return { config, command, args: [...prefixArgs, ...launch.args], environment: launch.environment };
  }

  function runPrepared(settings: ChildSettings, cwd: string, signal: AbortSignal | undefined): Promise<RunResult> {
    return runChild({
      command: settings.command,
      args: settings.args,
      cwd,
      environment: settings.environment,
      signal,
      stallTimeoutMs: settings.config.stallTimeoutMs,
      maxStderrChars: settings.config.maxStderrChars,
    });
  }

  function startInBackground(params: Static<typeof Parameters>, context: ExtensionContext) {
    // Without a UI nobody is there to receive the answer: pi may end before the child does.
    if (!context.hasUI) throw new Error("A background subagent needs an interactive session. Run it without background.");
    const settings = prepareChild(params, context);
    background.setMaxRunning(settings.config.maxBackground);
    const started = background.start({
      task: params.task,
      run: async (signal) => outcomeOf(await runPrepared(settings, context.cwd, signal)),
      onFinish: (task, outcome) =>
        pi.sendMessage(
          { customType: "subagent-result", content: formatBackgroundResult(task, outcome), display: true, details: { id: task.id, status: task.status } },
          { triggerTurn: true, deliverAs: "followUp" },
        ),
    });
    if ("refusal" in started) throw new Error(started.refusal);
    return textResult(`Started background subagent ${started.task.id}. Its answer will arrive as a new message.`);
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Run a task in a separate pi process with its own context window and return its final answer. " +
      "The subagent has no user to ask: when pi-automode would ask the user, the call is blocked instead. " +
      "While pi-automode is active, the subagent loads no other extension. " +
      "With background: true it returns at once and the answer arrives later as a new message.",
    parameters: Parameters,

    async execute(_toolCallId, params, signal, _onUpdate, context) {
      if (params.background) return startInBackground(params, context);

      const settings = prepareChild(params, context);
      const outcome = outcomeOf(await countingForeground(() => runPrepared(settings, context.cwd, signal)));
      if (outcome.error !== undefined) throw new Error(outcome.error);
      return textResult(outcome.text);
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "Subagent list",
    description: "List the background subagents of this session and their status.",
    parameters: Type.Object({}),
    async execute() {
      return textResult(describeList(background.list()));
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Subagent cancel",
    description: "Stop a running background subagent. No answer arrives for it.",
    parameters: IdParameters,
    async execute(_toolCallId, params) {
      const problem = background.cancel(params.id);
      if (problem) throw new Error(problem);
      return textResult(`Cancelled ${params.id}.`);
    },
  });

  const runningIds = () =>
    background
      .list()
      .filter((task) => task.status === "running")
      .map((task) => task.id);

  // A cancelled task sends no result, so without this note the model would wait for an answer that never comes.
  function tellModelAboutCancels(runningBefore: string[]): void {
    const stillRunning = new Set(runningIds());
    const cancelled = runningBefore.filter((id) => !stillRunning.has(id) && background.list().find((task) => task.id === id)?.status === "cancelled");
    if (cancelled.length === 0) return;
    pi.sendMessage(
      { customType: "subagent-result", content: `The user cancelled ${cancelled.join(", ")}. No answer will arrive.`, display: true, details: { ids: cancelled, status: "cancelled" } },
      { deliverAs: "followUp" },
    );
  }

  // Without arguments, a person uses a menu. An empty list means the person closed it.
  async function commandsFromMenu(context: Pick<ExtensionContext, "mode" | "ui">): Promise<string[]> {
    // Only the terminal can draw a custom component. RPC mode has a UI that cannot.
    if (context.mode !== "tui") return ["status", "list"];
    return showMenu(context.ui, () => background.list());
  }

  pi.registerCommand("subagent", {
    description: "Manage background subagents: list, cancel, history, status",
    getArgumentCompletions: (argumentText) =>
      completeArguments(
        argumentText,
        background
          .list()
          .filter((task) => task.status === "running")
          .map((task) => task.id),
      ),
    handler: async (args, context) => {
      const commands = args.trim() === "" ? await commandsFromMenu(context) : [args];
      for (const command of commands) {
        const runningBefore = runningIds();
        const result = runCommand({
          args: command,
          registry: background,
          now: Date.now(),
          config: loadSubagentConfig(configPath(getAgentDir())),
          configFile: configPath(getAgentDir()),
          guard: queryGuard(pi.events),
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

  // After the session ends no result can be delivered, so a child that goes on would only waste work.
  // pi aborts the old session before it emits session_shutdown. A result that arrives in between would start a turn in a dying session.
  pi.on("session_shutdown", cancelAllAndClearFooter);
  // A switch or fork can still fail after these events, and then no session_start follows. So they must keep the footer.
  pi.on("session_before_switch", () => background.cancelAll());
  pi.on("session_before_fork", () => background.cancelAll());
}
