import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { queryGuard } from "./guard.ts";
import { buildLaunch, CHILD_ENV } from "./launch.ts";
import { runChild } from "./run.ts";

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
});

export default function (pi: ExtensionAPI): void {
  if (process.env[CHILD_ENV]) return;

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Run a task in a separate pi process with its own context window and return its final answer. " +
      "The subagent has no user to ask: when pi-automode would ask the user, the call is blocked instead. " +
      "While pi-automode is active, the subagent loads no other extension.",
    parameters: Parameters,

    async execute(_toolCallId, params, signal, _onUpdate, context) {
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
        tools: params.tools,
        environment: process.env,
      });
      const { command, prefixArgs } = piCommand();
      const result = await runChild({
        command,
        args: [...prefixArgs, ...launch.args],
        cwd: context.cwd,
        environment: launch.environment,
        signal,
      });

      if (result.failure) throw new Error(result.failure);
      if (result.exitCode !== 0) throw new Error(`The subagent exited with code ${result.exitCode}: ${result.stderr.trim()}`);
      return { content: [{ type: "text", text: result.text || "(the subagent returned no text)" }], details: undefined };
    },
  });
}
