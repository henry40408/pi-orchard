import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLASSIFIER_SWITCH, completeArguments, LOG_SWITCH, MENU_ITEMS, runCommand } from "./command.ts";
import { MODES } from "./config/schema.ts";
import { showMenu } from "./menu.ts";
import { toggleRow, type MenuRow } from "./menu-model.ts";
import { FOOTER_KEY, footerText } from "./footer.ts";
import { answerQueries, announceStatus, type StatusMessage } from "./handshake.ts";
import { createToolCallHandler } from "./hook.ts";
import { DecisionHistory } from "./history.ts";
import { DecisionLog, LOG_FILE_ENV, logDirectory, logFileName, pruneOldLogs, readLoggedDecisions, sessionLogFiles } from "./log.ts";
import type { Config } from "./config/schema.ts";
import { createPiComplete, withClassifierModelFromEnvironment } from "./model.ts";
import { AutomodeState, parentLogEnabledFromEnvironment, parentModeFromEnvironment } from "./state.ts";

const ENTRY_PATH = fileURLToPath(import.meta.url);

export default function (pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  // Only a child pi takes its settings from the environment; a user's own variable must not change a normal session.
  const isChild = parentModeFromEnvironment(process.env) !== undefined;
  const state = new AutomodeState(agentDir, parentModeFromEnvironment(process.env), isChild ? parentLogEnabledFromEnvironment(process.env) : undefined);
  const history = new DecisionHistory();
  const classifierFor = (classifier: Config["classifier"]) => (isChild ? withClassifierModelFromEnvironment(classifier, process.env) : classifier);
  // One file per session. A child pi writes to its parent's file instead.
  let log: DecisionLog | undefined;
  let sessionId = "";

  // If the status cannot be built (say, the config cannot be read), a silent
  // handler would look like "automode is not installed". Report the strictest mode instead.
  function statusMessage(cwd?: string): StatusMessage {
    try {
      const status = state.status(cwd);
      const { classifier, log: logSettings } = state.config(state.cwd());
      return { ...status, entry: ENTRY_PATH, logFile: log?.file, classifierModel: classifierFor(classifier).model, logEnabled: logSettings.enabled };
    } catch {
      return { mode: "ask", active: true, entry: ENTRY_PATH };
    }
  }

  function publishStatus(context: Pick<ExtensionContext, "cwd" | "ui">): void {
    context.ui.setStatus(FOOTER_KEY, footerText(state, context.cwd));
    announceStatus(pi.events, statusMessage(context.cwd));
  }

  function startLog(settings: Config["log"], id: string): void {
    const parentFile = process.env[LOG_FILE_ENV];
    const file = parentFile || join(logDirectory(agentDir), logFileName(new Date(), id));
    log = new DecisionLog(file);
    sessionId = id;
    if (parentFile || !settings.enabled) return;
    pruneOldLogs({ directory: logDirectory(agentDir), keepDays: settings.keepDays, keepFiles: settings.keepFiles, currentFile: file });
  }

  pi.on("session_start", (_event, context) => {
    const { config, errors, ignored } = state.reload(context.cwd);
    startLog(config.log, context.sessionManager.getSessionId());
    for (const error of errors) context.ui.notify(`automode: ${error}`, "error");
    if (ignored.length > 0) context.ui.notify(`automode: ignored project settings: ${ignored.join(", ")}`, "warning");
    publishStatus(context);
  });

  pi.on(
    "tool_call",
    createToolCallHandler({
      state,
      history,
      currentLog: () => log,
      completeFor: (context, classifier) => createPiComplete(context, classifierFor(classifier)),
    }),
  );

  const loggedDecisions = (count: number) => readLoggedDecisions(sessionLogFiles(logDirectory(agentDir), sessionId), count);
  // A child writes to the file of its parent, whose name has the id of the parent's session, not the child's own: it reads its memory.
  const loggedDecisionsOrNone = process.env[LOG_FILE_ENV] ? undefined : loggedDecisions;

  // Without arguments, a person uses a menu; with no UI the command shows the status.
  // An empty list means the person closed the menu.
  async function commandsFromMenu(context: Pick<ExtensionContext, "mode" | "ui" | "cwd">): Promise<string[]> {
    // Only the terminal can draw a custom component. RPC mode has a UI that cannot.
    if (context.mode !== "tui") return ["status"];
    const { mode } = state.status(context.cwd);
    const { classifier, log: logSettings } = state.config(context.cwd);
    const rows: MenuRow[] = [
      toggleRow("mode", MODES, mode),
      toggleRow("classifier", CLASSIFIER_SWITCH, classifier.enabled ? "on" : "off"),
      toggleRow("log", LOG_SWITCH, logSettings.enabled ? "on" : "off"),
      ...MENU_ITEMS.map((item): MenuRow => ({ kind: "action", ...item })),
    ];
    return (await showMenu(context.ui, rows)) ?? [];
  }

  pi.registerCommand("automode", {
    description: "Show or change automode: status, mode, why, check, allow, ask, deny, rules, classifier, reload",
    getArgumentCompletions: completeArguments,
    handler: async (args, context) => {
      const commands = args.trim() === "" ? await commandsFromMenu(context) : [args];
      for (const command of commands) {
        const result = await runCommand({ args: command, cwd: context.cwd, state, history, log, loggedDecisions: loggedDecisionsOrNone });
        context.ui.notify(result.message, result.type);
      }
      if (commands.length > 0) publishStatus(context);
    },
  });

  answerQueries(pi.events, () => statusMessage());
}
