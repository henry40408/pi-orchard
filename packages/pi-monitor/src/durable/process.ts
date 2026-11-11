import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { MonitorExit, MonitorProcess, MonitorRunRequest } from "../core/process.ts";

/**
 * Runs the command in the execution environment of the host, so a monitor follows the same rules as `bash`.
 * The command must outlive the tool call that starts it, so it gets its own context, not the context of the call.
 */
export function startEnvProcess(env: ExecutionEnv, request: MonitorRunRequest): MonitorProcess {
  const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
  const done = env
    .exec(
      request.command,
      {
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        onOutput: (text, _context, { stream }) => request.onData(stream, text),
      },
      context,
    )
    .then((result): MonitorExit => {
      if (result.ok) return { exitCode: result.value.exitCode, signal: undefined, startError: undefined };
      const { code, message } = result.error;
      if (code === "spawn_error" || code === "shell_unavailable") return { exitCode: undefined, signal: undefined, startError: message };
      // The command may have run: an abort, a failed callback or a cleanup of the host ends it, so it did not fail to start.
      return { exitCode: undefined, signal: code, startError: undefined };
    })
    .catch((error: unknown): MonitorExit => ({ exitCode: undefined, signal: undefined, startError: error instanceof Error ? error.message : String(error) }));
  return { kill: () => cancel("monitor stopped"), done };
}
