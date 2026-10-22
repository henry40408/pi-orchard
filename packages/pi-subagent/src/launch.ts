import { CLASSIFIER_MODEL_ENV, LOG_ENABLED_ENV, LOG_FILE_ENV, PARENT_MODE_ENV, type GuardPlan } from "./guard.ts";

/** Set in every child, so that a child does not offer the `subagent` tool and cannot start children. */
export const CHILD_ENV = "PI_SUBAGENT_CHILD";

export interface LaunchRequest {
  task: string;
  /** The result of the automode handshake. It must not be `invalid`. */
  guard: Exclude<GuardPlan, { kind: "invalid" }>;
  /** The model the model asked for. */
  requestedModel?: string;
  /** The model of this session. It also checks a guarded child, unless the config names a classifier model. */
  parentModel?: string;
  /** From the config. Used when the model asked for none. */
  defaultModel?: string;
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
  // A guarded child on a cheap model needs a known model to check it; without one it would check itself.
  const classifierModel = request.guard.kind === "guarded" ? (request.guard.classifierModel ?? request.parentModel) : undefined;
  const mayChooseModel = request.guard.kind !== "guarded" || classifierModel !== undefined;
  const model = mayChooseModel ? (request.requestedModel ?? request.defaultModel ?? request.parentModel) : request.parentModel;
  if (model) args.push("--model", model);
  if (request.tools && request.tools.length > 0) args.push("--tools", request.tools.join(","));
  // The prefix keeps a task that starts with "-" from being read as an option.
  args.push(`Task: ${request.task}`);

  const environment: Record<string, string | undefined> = { ...request.environment, [CHILD_ENV]: "1" };
  if (request.guard.kind === "guarded") {
    environment[PARENT_MODE_ENV] = request.guard.mode;
    if (request.guard.logFile) environment[LOG_FILE_ENV] = request.guard.logFile;
    // The parent's switch beats an inherited variable, and an old parent that sends none must not leave a stale one.
    delete environment[LOG_ENABLED_ENV];
    if (request.guard.logEnabled !== undefined) environment[LOG_ENABLED_ENV] = request.guard.logEnabled ? "1" : "0";
    // The child may work on any model, but its tool calls are checked by the model that checks the parent's.
    if (classifierModel) environment[CLASSIFIER_MODEL_ENV] = classifierModel;
  }
  return { args, environment };
}
