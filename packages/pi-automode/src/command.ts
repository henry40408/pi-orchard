import { MODES } from "./config/schema.ts";
import { isMode, type AutomodeState } from "./state.ts";

export interface CommandResult {
  message: string;
  type: "info" | "warning" | "error";
}

export const COMMAND_ARGUMENTS = [...MODES, "reload", "status"];

function describeStatus(state: AutomodeState, cwd: string): CommandResult {
  const { mode } = state.status(cwd);
  const { errors, ignored } = state.problems(cwd);
  const lines = [`automode mode: ${mode}`];
  for (const error of errors) lines.push(`error: ${error}`);
  if (ignored.length > 0) lines.push(`ignored project settings: ${ignored.join(", ")}`);
  return { message: lines.join("\n"), type: errors.length > 0 ? "error" : "info" };
}

/** `/automode [status | reload | auto | rules | ask | off]` */
export function runCommand(args: string, state: AutomodeState, cwd: string): CommandResult {
  const word = args.trim();
  if (word === "" || word === "status") return describeStatus(state, cwd);

  if (word === "reload") {
    state.reload(cwd);
    return describeStatus(state, cwd);
  }
  if (!isMode(word)) {
    return { message: `Unknown argument "${word}". Use one of: ${COMMAND_ARGUMENTS.join(", ")}`, type: "error" };
  }

  const refusal = state.setMode(cwd, word);
  if (refusal) return { message: refusal, type: "error" };
  return { message: `automode mode is now ${word} for this session`, type: word === "off" ? "warning" : "info" };
}
