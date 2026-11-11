export interface MonitorRunRequest {
  command: string;
  /** Omitted: the host's own working directory. */
  cwd?: string;
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
  /** Stops the whole process tree. */
  kill(): void;
  done: Promise<MonitorExit>;
}
