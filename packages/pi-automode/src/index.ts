import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COMMAND_ARGUMENTS, runCommand } from "./command.ts";
import { announceStatus, answerQueries } from "./handshake.ts";
import { createToolCallHandler } from "./hook.ts";
import { createPiComplete } from "./model.ts";
import { AutomodeState } from "./state.ts";

export default function (pi: ExtensionAPI): void {
  const state = new AutomodeState(getAgentDir());

  pi.on("session_start", (_event, context) => {
    const { errors, ignored } = state.reload(context.cwd);
    for (const error of errors) context.ui.notify(`automode: ${error}`, "error");
    if (ignored.length > 0) context.ui.notify(`automode: ignored project settings: ${ignored.join(", ")}`, "warning");
    announceStatus(pi.events, state.status(context.cwd));
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
      announceStatus(pi.events, state.status(context.cwd));
    },
  });

  answerQueries(pi.events, () => state.status());
}
