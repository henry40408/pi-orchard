import { PARENT_MODE_ENV, type GuardPlan } from "./guard.ts";

/** Set in every child, so that a child does not offer the `subagent` tool and cannot start children. */
export const CHILD_ENV = "PI_SUBAGENT_CHILD";

export interface LaunchRequest {
  task: string;
  /** The result of the automode handshake. It must not be `invalid`. */
  guard: Exclude<GuardPlan, { kind: "invalid" }>;
  /** The model the model asked for. Ignored while automode guards the child. */
  requestedModel?: string;
  /** The model of this session. */
  parentModel?: string;
  tools?: string[];
  environment: Record<string, string | undefined>;
}

export interface Launch {
  args: string[];
  environment: Record<string, string | undefined>;
}

/**
 * The pi arguments and environment of a child. With automode in the parent,
 * the child loads only automode, from the parent's own file: `--no-extensions`
 * stops discovery, and the explicit `-e` still loads. This also leaves the
 * child without a `subagent` tool, so children cannot start children.
 */
export function buildLaunch(request: LaunchRequest): Launch {
  const args = ["--mode", "json", "-p", "--no-session"];
  if (request.guard.kind === "guarded") args.push("--no-extensions", "-e", request.guard.entry);
  // Under automode the child's model is also its classifier, so the model may not pick a weaker one.
  const model = request.guard.kind === "guarded" ? request.parentModel : (request.requestedModel ?? request.parentModel);
  if (model) args.push("--model", model);
  if (request.tools && request.tools.length > 0) args.push("--tools", request.tools.join(","));
  // The prefix keeps a task that starts with "-" from being read as an option.
  args.push(`Task: ${request.task}`);

  const environment: Record<string, string | undefined> = { ...request.environment, [CHILD_ENV]: "1" };
  if (request.guard.kind === "guarded") environment[PARENT_MODE_ENV] = request.guard.mode;
  return { args, environment };
}
