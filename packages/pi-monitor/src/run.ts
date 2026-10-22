import { spawn } from "node:child_process";

export interface MonitorRunRequest {
  command: string;
  cwd: string;
  /** The shell and its flag, for example `/bin/bash` and `-c`. */
  shell: { path: string; args: string[] };
  onData: (stream: "stdout" | "stderr", chunk: string) => void;
}

export interface MonitorExit {
  exitCode: number | undefined;
  /** The signal that ended the process, when there was one. */
  signal: string | undefined;
  /** Set when the process could not start. */
  startError: string | undefined;
}

export interface MonitorProcess {
  /** Stops the whole process tree: SIGTERM first, SIGKILL after the grace period. */
  kill(): void;
  done: Promise<MonitorExit>;
}

const KILL_GRACE_MS = 5000;

/**
 * Starts the command in its own process group, so a kill also reaches the
 * children of the shell (for example the `tail` in `tail -f log | grep x`).
 * The callback gets raw chunks. Splitting them into lines is the caller's job.
 */
export function startMonitorProcess(request: MonitorRunRequest): MonitorProcess {
  const child = spawn(request.shell.path, [...request.shell.args, request.command], {
    cwd: request.cwd,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => request.onData("stdout", chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => request.onData("stderr", chunk));

  const done = new Promise<MonitorExit>((resolve) => {
    child.on("error", (error) => resolve({ exitCode: undefined, signal: undefined, startError: error.message }));
    child.on("close", (exitCode, signal) => resolve({ exitCode: exitCode ?? undefined, signal: signal ?? undefined, startError: undefined }));
  });

  let killing = false;
  const signalTree = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The group is already gone.
    }
  };
  const kill = () => {
    if (killing) return;
    killing = true;
    signalTree("SIGTERM");
    // The group may outlive the shell, so the SIGKILL does not wait for `close`.
    setTimeout(() => signalTree("SIGKILL"), KILL_GRACE_MS).unref();
  };
  return { kill, done };
}
