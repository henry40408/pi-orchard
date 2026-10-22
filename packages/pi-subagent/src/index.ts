import { existsSync } from "node:fs";
import { basename } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { BackgroundRegistry, type BackgroundOutcome, type BackgroundTask } from "./background.ts";
import { FOOTER_KEY, footerText } from "./footer.ts";
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
    Type.String({ description: "Model for the subagent, as provider/id. Default: the current model. Ignored while pi-automode is active." }),
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

  // The registry reports from callbacks that have no context, so the ui of the last background start is kept here.
  let footerUi: ExtensionContext["ui"] | undefined;
  const background = new BackgroundRegistry({
    maxRunning: DEFAULT_CONFIG.maxBackground,
    onChange: (runningCount) => footerUi?.setStatus(FOOTER_KEY, footerText(runningCount)),
  });

  function cancelAllAndClearFooter(): void {
    background.cancelAll();
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
    footerUi = context.ui;
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

      const outcome = outcomeOf(await runPrepared(prepareChild(params, context), context.cwd, signal));
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

  // After the session ends no result can be delivered, so a child that goes on would only waste work.
  // pi aborts the old session before it emits session_shutdown. A result that arrives in between would start a turn in a dying session.
  pi.on("session_shutdown", cancelAllAndClearFooter);
  pi.on("session_before_switch", cancelAllAndClearFooter);
  pi.on("session_before_fork", cancelAllAndClearFooter);
}
