import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeArguments, MENU_ITEMS, runCommand } from "./command.ts";
import { FOOTER_KEY, footerText } from "./footer.ts";
import { answerQueries, announceStatus, type StatusMessage } from "./handshake.ts";
import { createToolCallHandler } from "./hook.ts";
import { DecisionHistory } from "./history.ts";
import { DecisionLog, LOG_FILE_ENV, logDirectory, logFileName, pruneOldLogs } from "./log.ts";
import type { Config } from "./config/schema.ts";
import { createPiComplete } from "./model.ts";
import { AutomodeState, parentModeFromEnvironment } from "./state.ts";

const ENTRY_PATH = fileURLToPath(import.meta.url);

export default function (pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const state = new AutomodeState(agentDir, parentModeFromEnvironment(process.env));
  const history = new DecisionHistory();
  // One file per session. A child pi writes to its parent's file instead.
  let log: DecisionLog | undefined;

  // If the status cannot be built (say, the config cannot be read), a silent
  // handler would look like "automode is not installed". Report the strictest mode instead.
  function statusMessage(cwd?: string): StatusMessage {
    try {
      return { ...state.status(cwd), entry: ENTRY_PATH, logFile: log?.file };
    } catch {
      return { mode: "ask", active: true, entry: ENTRY_PATH };
    }
  }

  function publishStatus(context: Pick<ExtensionContext, "cwd" | "ui">): void {
    context.ui.setStatus(FOOTER_KEY, footerText(state, context.cwd));
    announceStatus(pi.events, statusMessage(context.cwd));
  }

  function startLog(settings: Config["log"], sessionId: string): void {
    const parentFile = process.env[LOG_FILE_ENV];
    const file = parentFile || join(logDirectory(agentDir), logFileName(new Date(), sessionId));
    log = new DecisionLog(file);
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
      completeFor: (context, classifier) => createPiComplete(context, classifier),
    }),
  );

  // Without arguments, a person picks from a menu; with no UI the command shows the status.
  // `undefined` means the person closed the menu.
  async function argumentsFromMenu(context: Pick<ExtensionContext, "hasUI" | "ui">): Promise<string | undefined> {
    if (!context.hasUI) return "";
    const choice = await context.ui.select(
      "automode",
      MENU_ITEMS.map((item) => item.label),
    );
    return MENU_ITEMS.find((item) => item.label === choice)?.args;
  }

  pi.registerCommand("automode", {
    description: "Show or change automode: status, mode, why, check, allow, ask, deny, rules, classifier, reload",
    getArgumentCompletions: completeArguments,
    handler: async (args, context) => {
      const chosen = args.trim() === "" ? await argumentsFromMenu(context) : args;
      if (chosen === undefined) return;
      const result = await runCommand({ args: chosen, cwd: context.cwd, state, history, log });
      context.ui.notify(result.message, result.type);
      publishStatus(context);
    },
  });

  answerQueries(pi.events, () => statusMessage());
}
