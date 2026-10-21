import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COMMAND_ARGUMENTS, runCommand } from "./command.ts";
import { FOOTER_KEY, footerText } from "./footer.ts";
import { answerQueries, announceStatus, type StatusMessage } from "./handshake.ts";
import { createToolCallHandler } from "./hook.ts";
import { createPiComplete } from "./model.ts";
import { AutomodeState, parentModeFromEnvironment } from "./state.ts";

const ENTRY_PATH = fileURLToPath(import.meta.url);

export default function (pi: ExtensionAPI): void {
  const state = new AutomodeState(getAgentDir(), parentModeFromEnvironment(process.env));

  // If the status cannot be built (say, the config cannot be read), a silent
  // handler would look like "automode is not installed". Report the strictest mode instead.
  function statusMessage(cwd?: string): StatusMessage {
    try {
      return { ...state.status(cwd), entry: ENTRY_PATH };
    } catch {
      return { mode: "ask", active: true, entry: ENTRY_PATH };
    }
  }

  function publishStatus(context: Pick<ExtensionContext, "cwd" | "ui">): void {
    context.ui.setStatus(FOOTER_KEY, footerText(state, context.cwd));
    announceStatus(pi.events, statusMessage(context.cwd));
  }

  pi.on("session_start", (_event, context) => {
    const { errors, ignored } = state.reload(context.cwd);
    for (const error of errors) context.ui.notify(`automode: ${error}`, "error");
    if (ignored.length > 0) context.ui.notify(`automode: ignored project settings: ${ignored.join(", ")}`, "warning");
    publishStatus(context);
  });

  pi.on(
    "tool_call",
    createToolCallHandler({
      state,
      completeFor: (context, classifier) => createPiComplete(context, classifier),
    }),
  );

  pi.registerCommand("automode", {
    description: "Show or change the automode setting: status, reload, auto, rules, ask, off",
    getArgumentCompletions: (prefix) =>
      COMMAND_ARGUMENTS.filter((word) => word.startsWith(prefix)).map((word) => ({ value: word, label: word })),
    handler: async (args, context) => {
      const result = runCommand(args, state, context.cwd);
      context.ui.notify(result.message, result.type);
      publishStatus(context);
    },
  });

  answerQueries(pi.events, () => statusMessage());
}
