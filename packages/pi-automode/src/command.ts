import { decide } from "./decide.ts";
import { MODES } from "./config/schema.ts";
import type { DecisionHistory, DecisionRecord } from "./history.ts";
import { PATH_TOOLS } from "./permissions/evaluate.ts";
import { createPathContext } from "./permissions/paths.ts";
import { parseRule } from "./permissions/rule.ts";
import { isMode, type AutomodeState, type RuleKind } from "./state.ts";

export interface CommandResult {
  message: string;
  type: "info" | "warning" | "error";
}

export interface CommandRequest {
  args: string;
  cwd: string;
  state: AutomodeState;
  history: DecisionHistory;
}

interface Subcommand {
  name: string;
  usage: string;
  description: string;
}

const SUBCOMMANDS: readonly Subcommand[] = [
  { name: "status", usage: "status", description: "Show the mode and any config problem" },
  { name: "mode", usage: `mode <${MODES.join("|")}>`, description: "Change the mode for this session" },
  { name: "why", usage: "why [count]", description: "Show the recent decisions" },
  { name: "check", usage: "check <tool> <input>", description: "Show what the rules say about a call, without running it" },
  { name: "allow", usage: "allow <rule>", description: "Add an allow rule for this session" },
  { name: "ask", usage: "ask <rule>", description: "Add an ask rule for this session" },
  { name: "deny", usage: "deny <rule>", description: "Add a deny rule for this session" },
  { name: "rules", usage: "rules", description: "List the rules in effect" },
  { name: "classifier", usage: "classifier <on|off|model <provider/id|default>>", description: "Change the classifier for this session" },
  { name: "reload", usage: "reload", description: "Read the config files again and drop the session changes" },
];

const USAGE = SUBCOMMANDS.map((subcommand) => subcommand.usage).join("\n");
const DEFAULT_WHY_COUNT = 10;

const CLASSIFIER_OPTIONS = ["on", "off", "model"];

export interface Completion {
  value: string;
  label: string;
  description?: string;
}

/** `value` replaces the whole argument text, so it repeats the words already typed. */
export function completeArguments(argumentText: string): Completion[] {
  const [first = "", ...rest] = argumentText.split(" ");
  if (rest.length === 0) {
    return SUBCOMMANDS.filter(({ name }) => name.startsWith(first)).map(({ name, description }) => ({
      value: name,
      label: name,
      description,
    }));
  }
  const options = first === "mode" ? MODES : first === "classifier" ? CLASSIFIER_OPTIONS : [];
  const typed = rest.join(" ");
  return options.filter((option) => option.startsWith(typed)).map((option) => ({ value: `${first} ${option}`, label: option }));
}

/** What the menu of a bare `/automode` offers: each label runs the arguments next to it. */
export const MENU_ITEMS: ReadonlyArray<{ label: string; args: string }> = [
  { label: "status", args: "status" },
  { label: "why: recent decisions", args: "why" },
  { label: "rules: rules in effect", args: "rules" },
  ...MODES.map((mode) => ({ label: `mode ${mode}`, args: `mode ${mode}` })),
  { label: "classifier on", args: "classifier on" },
  { label: "classifier off", args: "classifier off" },
  { label: "reload", args: "reload" },
];

function error(message: string): CommandResult {
  return { message, type: "error" };
}

function info(message: string): CommandResult {
  return { message, type: "info" };
}

function describeStatus({ state, cwd }: CommandRequest): CommandResult {
  const { mode } = state.status(cwd);
  const { errors, ignored } = state.problems(cwd);
  const { classifier } = state.config(cwd);
  const lines = [`automode mode: ${mode}`, `classifier: ${classifier.enabled ? "on" : "off"}, model ${classifier.model ?? "(session model)"}`];
  for (const message of errors) lines.push(`error: ${message}`);
  if (ignored.length > 0) lines.push(`ignored project settings: ${ignored.join(", ")}`);
  return { message: lines.join("\n"), type: errors.length > 0 ? "error" : "info" };
}

function changeMode({ state, cwd }: CommandRequest, word: string): CommandResult {
  if (!isMode(word)) return error(`"${word}" is not a mode. Use one of: ${MODES.join(", ")}`);
  const refusal = state.setMode(cwd, word);
  if (refusal) return error(refusal);
  return { message: `automode mode is now ${word} for this session`, type: word === "off" ? "warning" : "info" };
}

function describeRecord(record: DecisionRecord): string {
  const time = record.time.toTimeString().slice(0, 8);
  const answer = record.answer ? `, user: ${record.answer}` : "";
  const { action, source, reason } = record.outcome;
  return `${time} ${record.toolName} ${record.summary}\n  -> ${action} (${source}${answer}): ${reason}`;
}

function showHistory({ history }: CommandRequest, countText: string): CommandResult {
  const count = countText === "" ? DEFAULT_WHY_COUNT : Number(countText);
  if (!Number.isInteger(count) || count < 1) return error(`"${countText}" is not a count. Use a positive number`);
  const records = history.recent(count);
  if (records.length === 0) return info("No tool call has been decided in this session yet");
  return info(records.map(describeRecord).join("\n"));
}

type InputParse = { input: unknown } | { failure: string };

function parseCheckInput(toolName: string, text: string): InputParse {
  if (text.startsWith("{")) {
    try {
      return { input: JSON.parse(text) as unknown };
    } catch {
      return { failure: "The input starts with { but is not valid JSON" };
    }
  }
  if (toolName === "bash") return { input: { command: text } };
  if (PATH_TOOLS.has(toolName)) return { input: { path: text } };
  return { failure: `For ${toolName}, write the input as JSON, e.g. {"url":"..."}` };
}

async function checkCall({ state, cwd }: CommandRequest, argumentText: string): Promise<CommandResult> {
  const separator = argumentText.indexOf(" ");
  const toolName = (separator === -1 ? argumentText : argumentText.slice(0, separator)).toLowerCase();
  const inputText = separator === -1 ? "" : argumentText.slice(separator + 1).trim();
  if (toolName === "" || inputText === "") return error("Usage: /automode check <tool> <input>");

  const parsed = parseCheckInput(toolName, inputText);
  if ("failure" in parsed) return error(parsed.failure);

  let classifierWouldJudge = false;
  const outcome = await decide({
    config: state.config(cwd),
    toolName,
    input: parsed.input,
    pathContext: createPathContext(cwd),
    classifyAction: async () => {
      classifierWouldJudge = true;
      return { decision: "ask", reason: "" };
    },
  });
  if (classifierWouldJudge) return info("undecided: no rule decides this call, so the classifier would judge it (check does not run the classifier)");
  return info(`${outcome.action} (${outcome.source}): ${outcome.reason}`);
}

function addRule({ state, cwd }: CommandRequest, kind: RuleKind, rule: string): CommandResult {
  if (rule === "") return error(`Usage: /automode ${kind} <rule>`);
  const refusal = state.addRule(cwd, kind, rule);
  if (refusal) return error(refusal);
  const { tool, specifier } = parseRule(rule);
  if (specifier === undefined) {
    return { message: `Added the ${kind} rule ${rule} for this session. It has no specifier, so it covers every ${tool} call`, type: "warning" };
  }
  return info(`Added the ${kind} rule ${rule} for this session`);
}

function listRules({ state, cwd }: CommandRequest): CommandResult {
  const lines = state.rulesInEffect(cwd).map(({ kind, rule, session }) => `${kind}: ${rule}${session ? " (session)" : ""}`);
  return info(lines.length > 0 ? lines.join("\n") : "No permission rules");
}

function changeClassifier(request: CommandRequest, argumentText: string): CommandResult {
  const { state, cwd } = request;
  const [option, ...rest] = argumentText.split(/\s+/);
  const value = rest.join(" ");
  if (option === "on" || option === "off") {
    const refusal = state.setClassifierEnabled(cwd, option === "on");
    return refusal ? error(refusal) : info(`The classifier is ${option} for this session`);
  }
  if (option === "model" && value !== "") {
    const refusal = state.setClassifierModel(cwd, value === "default" ? undefined : value);
    return refusal ? error(refusal) : info(`The classifier model is ${value === "default" ? "back to the configured one" : value} for this session`);
  }
  return error("Usage: /automode classifier <on|off|model <provider/id|default>>");
}

/** `/automode <subcommand> [arguments]`. It only reads and changes `state` and `history`; showing the result is the caller's job. */
export async function runCommand(request: CommandRequest): Promise<CommandResult> {
  const text = request.args.trim();
  const separator = text.search(/\s/);
  const subcommand = separator === -1 ? text : text.slice(0, separator);
  const rest = separator === -1 ? "" : text.slice(separator).trim();

  switch (subcommand) {
    case "":
    case "status":
      return describeStatus(request);
    case "mode":
      return changeMode(request, rest);
    case "reload":
      request.state.reload(request.cwd);
      return describeStatus(request);
    case "why":
      return showHistory(request, rest);
    case "check":
      return checkCall(request, rest);
    case "allow":
    case "ask":
    case "deny":
      return addRule(request, subcommand, rest);
    case "rules":
      return listRules(request);
    case "classifier":
      return changeClassifier(request, rest);
    default:
      return error(`Unknown argument "${subcommand}". Use:\n${USAGE}`);
  }
}
