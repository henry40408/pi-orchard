import { spawn } from "node:child_process";

export interface RunRequest {
  command: string;
  args: string[];
  cwd: string;
  environment: Record<string, string | undefined>;
  signal: AbortSignal | undefined;
}

export interface RunResult {
  /** The text of the last assistant message. */
  text: string;
  exitCode: number;
  stderr: string;
  /** Set when the last assistant message ended with an error or an abort. */
  failure: string | undefined;
}

const KILL_GRACE_MS = 5000;

interface AssistantMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/** Reads one JSONL stream and keeps the last assistant message. */
export class ChildOutput {
  #buffer = "";
  #last: AssistantMessage | undefined;

  push(chunk: string): void {
    this.#buffer += chunk;
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    for (const line of lines) this.#read(line);
  }

  finish(): void {
    this.#read(this.#buffer);
    this.#buffer = "";
  }

  #read(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let event: { type?: string; message?: AssistantMessage };
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") this.#last = event.message;
  }

  get text(): string {
    return textOf(this.#last?.content);
  }

  get failure(): string | undefined {
    const stopReason = this.#last?.stopReason;
    if (stopReason !== "error" && stopReason !== "aborted" && stopReason !== "length") return undefined;
    return this.#last?.errorMessage ?? `The subagent stopped before it finished: ${stopReason}`;
  }
}

export function runChild(request: RunRequest): Promise<RunResult> {
  return new Promise((resolve) => {
    const output = new ChildOutput();
    let stderr = "";
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.environment as NodeJS.ProcessEnv,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => output.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    const settle = (exitCode: number, extraStderr = "") => {
      output.finish();
      resolve({ text: output.text, exitCode, stderr: stderr + extraStderr, failure: output.failure });
    };
    child.on("error", (error) => settle(1, error.message));
    child.on("close", (code) => settle(code ?? 1));

    const { signal } = request;
    if (!signal) return;
    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };
    if (signal.aborted) kill();
    else signal.addEventListener("abort", kill, { once: true });
  });
}
