import { existsSync } from "node:fs";
import { analyzeBash, type BashUnit, matchesBashSpecifier } from "./bash.ts";
import { matchesPathSpecifier, mayMatchInside, type PathContext, pathForms, symlinkTarget } from "./paths.ts";
import { parseRule, type Rule } from "./rule.ts";

export interface Permissions {
  allow: string[];
  ask: string[];
  deny: string[];
}

/**
 * `none` means no rule decided; the caller treats it like `ask`.
 * `symlink` means the path goes through a symlink: the caller blocks the call
 * and tells the model `realPath`, so the model asks again with that path.
 */
export type Decision = "allow" | "ask" | "deny" | "none" | "symlink";

export interface Evaluation {
  decision: Decision;
  /** The rule that decided, as written in the config. */
  rule?: string;
  /** Set when `decision` is `symlink`. */
  realPath?: string;
}

export interface EvaluateInput {
  permissions: Permissions;
  toolName: string;
  input: unknown;
  pathContext: PathContext;
}

interface Target {
  /** The things a rule is matched against: shell commands or file paths. */
  units: BashUnit[];
  /** False when the call cannot be fully analysed; it can then never be allowed by a specifier rule. */
  complete: boolean;
}

interface SpecifierMatcher {
  /** Whether a deny or ask specifier applies to the form. */
  blocks: (form: string, specifier: string) => boolean;
  /** Whether an allow specifier covers the form. */
  covers: (form: string, specifier: string) => boolean;
}

const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "find", "grep"]);
// These read everything below the given directory.
const DIRECTORY_TOOLS = new Set(["ls", "find", "grep"]);

function readField(input: unknown, field: string): unknown {
  if (typeof input !== "object" || input === null) return undefined;
  return (input as Record<string, unknown>)[field];
}

function describeTarget(toolName: string, input: unknown, context: PathContext): Target {
  if (toolName === "bash") {
    const command = readField(input, "command");
    if (typeof command !== "string") return { units: [], complete: false };
    return analyzeBash(command);
  }

  if (PATH_TOOLS.has(toolName)) {
    // ls, find and grep default to the working directory.
    const raw = readField(input, "path") ?? ".";
    if (typeof raw !== "string") return { units: [], complete: false };
    const forms = pathForms(raw, context, { readFallbacks: toolName === "read" });
    return { units: [{ blockForms: forms, allowForms: forms }], complete: true };
  }

  return { units: [], complete: false };
}

function findSymlinkTarget(toolName: string, target: Target, context: PathContext): string | undefined {
  if (!PATH_TOOLS.has(toolName)) return undefined;
  for (const unit of target.units) {
    // pi tries its fallback spellings only when the path as written does not exist.
    const [written] = unit.allowForms;
    const candidates = written !== undefined && existsSync(written) ? [written] : unit.allowForms;
    for (const form of candidates) {
      const realPath = symlinkTarget(form, context);
      if (realPath !== undefined) return realPath;
    }
  }
  return undefined;
}

function matcherFor(toolName: string, context: PathContext): SpecifierMatcher {
  if (toolName === "bash") return { blocks: matchesBashSpecifier, covers: matchesBashSpecifier };
  if (PATH_TOOLS.has(toolName)) {
    const covers = (form: string, specifier: string) => matchesPathSpecifier(form, specifier, context);
    const blocks = DIRECTORY_TOOLS.has(toolName)
      ? (form: string, specifier: string) =>
          covers(form, specifier) || mayMatchInside(form, specifier, context)
      : covers;
    return { blocks, covers };
  }
  // Specifiers have no meaning for other tools, so they never match.
  return { blocks: () => false, covers: () => false };
}

/**
 * Decides a tool call from the permission rules.
 * Priority is fixed: deny, then ask, then allow, whatever the order of the
 * rules. An allow needs every command (or path) of the call to be covered.
 */
export function evaluatePermissions(request: EvaluateInput): Evaluation {
  try {
    return evaluateRules(request);
  } catch {
    // Anything unexpected must end in a question to the user, never in an allow.
    return { decision: "none" };
  }
}

function evaluateRules(request: EvaluateInput): Evaluation {
  const { permissions, input, pathContext } = request;
  const toolName = request.toolName.toLowerCase();
  const rulesFor = (raws: string[]): Rule[] =>
    raws.map(parseRule).filter((rule) => rule.tool === toolName);

  const target = describeTarget(toolName, input, pathContext);
  const matcher = matcherFor(toolName, pathContext);

  // Before any rule: the rules must judge the real path, not the link.
  const realPath = findSymlinkTarget(toolName, target, pathContext);
  if (realPath !== undefined) return { decision: "symlink", realPath };

  const blocks = (rule: Rule): boolean =>
    rule.specifier === undefined ||
    target.units.some((unit) => unit.blockForms.some((form) => matcher.blocks(form, rule.specifier!)));

  for (const decision of ["deny", "ask"] as const) {
    const hit = rulesFor(permissions[decision]).find(blocks);
    if (hit) return { decision, rule: hit.raw };
  }

  const allowRules = rulesFor(permissions.allow);
  const whole = allowRules.find((rule) => rule.specifier === undefined);
  if (whole) return { decision: "allow", rule: whole.raw };

  if (!target.complete || target.units.length === 0) return { decision: "none" };

  const coveringRules: Rule[] = [];
  for (const unit of target.units) {
    const covering = allowRules.find((rule) =>
      unit.allowForms.every((form) => matcher.covers(form, rule.specifier!)),
    );
    if (!covering) return { decision: "none" };
    coveringRules.push(covering);
  }
  return { decision: "allow", rule: coveringRules[0]!.raw };
}
