import type { ClassifierVerdict } from "./classifier/classify.ts";
import type { Config } from "./config/schema.ts";
import { evaluatePermissions, isInsideWorkingDirectory } from "./permissions/evaluate.ts";
import type { PathContext } from "./permissions/paths.ts";

/** What to do with a tool call. `ask` means the user decides. */
export interface Outcome {
  action: "allow" | "ask" | "block";
  /** Shown to the user, and to the model when the call is blocked. */
  reason: string;
}

export interface DecideRequest {
  config: Config;
  toolName: string;
  input: unknown;
  pathContext: PathContext;
  /** Called only when the rules did not decide and the mode is `auto`. */
  classifyAction: () => Promise<ClassifierVerdict>;
}

const VERDICT_ACTIONS = { allow: "allow", ask: "ask", deny: "block" } as const;

/**
 * The order is fixed: a symlink is reported and a deny rule blocks in every
 * mode except `off`; only then do the mode, the working-directory shortcut and
 * the classifier come in. Nothing but an explicit allow, or an allow from the
 * classifier, lets a call run without the user.
 */
export async function decide(request: DecideRequest): Promise<Outcome> {
  const { config, toolName, input, pathContext } = request;
  if (config.mode === "off") return { action: "allow", reason: "automode is off" };

  const evaluation = evaluatePermissions({ permissions: config.permissions, toolName, input, pathContext });
  if (evaluation.decision === "symlink") {
    return {
      action: "block",
      reason: `This path goes through a symlink. Use the real path instead: ${evaluation.realPath}`,
    };
  }
  if (evaluation.decision === "deny") {
    return { action: "block", reason: `Blocked by the deny rule ${evaluation.rule}` };
  }
  if (config.mode === "ask") return { action: "ask", reason: "automode is set to ask" };

  if (evaluation.decision === "ask") return { action: "ask", reason: `The ask rule ${evaluation.rule} applies` };
  if (evaluation.decision === "allow") return { action: "allow", reason: `Allowed by the rule ${evaluation.rule}` };

  if (config.allowInsideWorkingDirectory && isInsideWorkingDirectory(toolName, input, pathContext)) {
    return { action: "allow", reason: "The path is inside the working directory" };
  }
  if (config.mode === "rules" || !config.classifier.enabled) {
    return { action: "ask", reason: "No rule allows this call" };
  }

  const verdict = await request.classifyAction();
  return { action: VERDICT_ACTIONS[verdict.decision], reason: verdict.reason };
}
