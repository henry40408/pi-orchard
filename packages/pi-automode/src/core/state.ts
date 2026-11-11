import { join, resolve } from "node:path";
import { loadConfig, type LoadedConfig } from "./config/load.ts";
import { stricterMode } from "./config/merge.ts";
import { MODES, type Config, type Mode } from "./config/schema.ts";
import { LOG_ENABLED_ENV } from "./log.ts";
import { PATH_TOOLS } from "./permissions/evaluate.ts";
import { parseRule, RULE_PATTERN } from "./permissions/rule.ts";

export interface AutomodeStatus {
  mode: Mode;
  /** False only in `off`: a child pi can tell whether its parent is guarded. */
  active: boolean;
}

export interface ConfigPaths {
  user: string;
  project: string;
}

export function configPaths(agentDir: string, cwd: string): ConfigPaths {
  return { user: join(agentDir, "automode.json"), project: join(cwd, ".pi", "automode.json") };
}

export function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value);
}

/** A parent pi sets this for a child pi; the child's mode is then never looser than the parent's. */
export const PARENT_MODE_ENV = "PI_AUTOMODE_PARENT_MODE";

/** An unset or unknown value means the child follows its own config. */
export function parentLogEnabledFromEnvironment(environment: Record<string, string | undefined>): boolean | undefined {
  const value = environment[LOG_ENABLED_ENV];
  if (value === "1") return true;
  if (value === "0") return false;
  return undefined;
}

/** An unset variable means no floor; a value that is not a mode means the strictest floor. */
export function parentModeFromEnvironment(environment: Record<string, string | undefined>): Mode | undefined {
  const value = environment[PARENT_MODE_ENV];
  if (value === undefined) return undefined;
  return isMode(value) ? value : "ask";
}

const RULE_KINDS = ["deny", "ask", "allow"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export type PermissionRules = Record<RuleKind, string[]>;

const RULE_REGEXP = new RegExp(RULE_PATTERN);
const MODEL_REGEXP = /^[^/\s]+\/\S+$/;

/**
 * A relative path specifier is anchored to the directory where the rule was
 * added; otherwise a change of directory would move the rule to other files.
 */
function anchorPathSpecifier(rule: string, cwd: string): string {
  const { tool, specifier } = parseRule(rule);
  if (specifier === undefined || !PATH_TOOLS.has(tool)) return rule;
  if (specifier === "~" || specifier.startsWith("~/")) return rule;
  // The matcher reads glob characters in an absolute specifier as wildcards, but takes the working directory literally.
  if (/[*?[]/.test(cwd)) return rule;
  return `${rule.slice(0, rule.indexOf("("))}(${resolve(cwd, specifier)})`;
}

/**
 * The config of the running session. It is read again for a new working
 * directory and on `reload`. The mode, the session rules and the classifier
 * override change this session only; only `reload` clears them, so a change of
 * directory cannot undo them.
 */
export class AutomodeState {
  #agentDir: string;
  #cwd: string | undefined;
  #loaded: LoadedConfig | undefined;
  #modeOverride: Mode | undefined;
  #sessionRules: PermissionRules = { allow: [], ask: [], deny: [] };
  #classifierOverride: { enabled?: boolean; model?: string } = {};
  #logOverride: boolean | undefined;
  #parentMode: Mode | undefined;
  #parentLogEnabled: boolean | undefined;

  constructor(agentDir: string, parentMode?: Mode, parentLogEnabled?: boolean) {
    this.#agentDir = agentDir;
    this.#parentMode = parentMode;
    this.#parentLogEnabled = parentLogEnabled;
  }

  reload(cwd: string): LoadedConfig {
    this.#modeOverride = undefined;
    this.#sessionRules = { allow: [], ask: [], deny: [] };
    this.#classifierOverride = {};
    this.#logOverride = undefined;
    return this.#load(cwd);
  }

  #load(cwd: string): LoadedConfig {
    this.#cwd = cwd;
    this.#loaded = loadConfig(configPaths(this.#agentDir, cwd));
    return this.#loaded;
  }

  #ensureLoaded(cwd: string): LoadedConfig {
    if (this.#loaded && this.#cwd === cwd) return this.#loaded;
    return this.#load(cwd);
  }

  config(cwd: string): Config {
    const { config, errors } = this.#ensureLoaded(cwd);
    // An invalid file must keep the mode at ask, whatever was set before.
    // Session deny and ask rules only make the guard stricter, so they stay.
    if (errors.length > 0) {
      const { allow } = config.permissions;
      const { ask, deny } = this.#sessionRules;
      return this.#withParentFloor({
        ...config,
        permissions: { allow, ask: [...config.permissions.ask, ...ask], deny: [...config.permissions.deny, ...deny] },
      });
    }
    return this.#withParentFloor({
      ...config,
      mode: this.#modeOverride ?? config.mode,
      permissions: {
        allow: [...config.permissions.allow, ...this.#sessionRules.allow],
        ask: [...config.permissions.ask, ...this.#sessionRules.ask],
        deny: [...config.permissions.deny, ...this.#sessionRules.deny],
      },
      classifier: { ...config.classifier, ...this.#classifierOverride },
      log: { ...config.log, enabled: this.#logOverride ?? config.log.enabled },
    });
  }

  #withParentFloor(config: Config): Config {
    // A child logs when its parent does, whatever its own files and commands say.
    const withLog = this.#parentLogEnabled === undefined ? config : { ...config, log: { ...config.log, enabled: this.#parentLogEnabled } };
    if (!this.#parentMode) return withLog;
    const mode = stricterMode(withLog.mode, this.#parentMode);
    return mode === withLog.mode ? withLog : { ...withLog, mode };
  }

  /** The permission rules in effect; `session` marks those added with `addRule`. */
  rulesInEffect(cwd: string): Array<{ kind: RuleKind; rule: string; session: boolean }> {
    const { config, errors } = this.#ensureLoaded(cwd);
    return RULE_KINDS.flatMap((kind) => {
      // Matches `config()`: session allow rules do not count while a file is invalid.
      const sessionRules = kind === "allow" && errors.length > 0 ? [] : this.#sessionRules[kind];
      return [
        ...config.permissions[kind].map((rule) => ({ kind, rule, session: false })),
        ...sessionRules.map((rule) => ({ kind, rule, session: true })),
      ];
    });
  }

  /** A rule lasts until `reload`. Refuses while a config file is invalid. */
  addRule(cwd: string, kind: RuleKind, rule: string): string | undefined {
    const refusal = this.#refusalForInvalidConfig(cwd);
    if (refusal) return refusal;
    if (!RULE_REGEXP.test(rule)) return `"${rule}" is not a permission rule. Write it as tool or tool(specifier), e.g. bash(git push:*)`;
    const anchored = anchorPathSpecifier(rule, cwd);
    if (!this.#sessionRules[kind].includes(anchored)) this.#sessionRules[kind].push(anchored);
    return undefined;
  }

  setClassifierEnabled(cwd: string, enabled: boolean): string | undefined {
    const refusal = this.#refusalForInvalidConfig(cwd);
    if (refusal) return refusal;
    this.#classifierOverride.enabled = enabled;
    return undefined;
  }

  setLogEnabled(cwd: string, enabled: boolean): string | undefined {
    const refusal = this.#refusalForInvalidConfig(cwd);
    if (refusal) return refusal;
    this.#logOverride = enabled;
    return undefined;
  }

  /** `undefined` goes back to the configured model. */
  setClassifierModel(cwd: string, model: string | undefined): string | undefined {
    const refusal = this.#refusalForInvalidConfig(cwd);
    if (refusal) return refusal;
    if (model === undefined) {
      delete this.#classifierOverride.model;
      return undefined;
    }
    if (!MODEL_REGEXP.test(model)) return `"${model}" is not a model. Write it as provider/id`;
    this.#classifierOverride.model = model;
    return undefined;
  }

  #refusalForInvalidConfig(cwd: string): string | undefined {
    if (this.#ensureLoaded(cwd).errors.length === 0) return undefined;
    return "A config file is invalid. Fix it and run /automode reload first.";
  }

  problems(cwd: string): { errors: string[]; ignored: string[] } {
    const { errors, ignored } = this.#ensureLoaded(cwd);
    return { errors, ignored };
  }

  /** True in a child pi: its user messages come from the parent agent, not from a person. */
  get isChild(): boolean {
    return this.#parentMode !== undefined;
  }

  /** Refuses while a config file is invalid, so a broken file cannot be hidden by a command. */
  setMode(cwd: string, mode: Mode): string | undefined {
    const refusal = this.#refusalForInvalidConfig(cwd);
    if (refusal) return refusal;
    if (this.#parentMode && stricterMode(mode, this.#parentMode) !== mode) {
      return `The parent session runs in ${this.#parentMode} mode; this session cannot be looser.`;
    }
    this.#modeOverride = mode;
    return undefined;
  }

  /** The directory used last; before any, the process directory. */
  cwd(): string {
    return this.#cwd ?? process.cwd();
  }

  /** Without a directory, the one used last; before any, the process directory. */
  status(cwd: string = this.#cwd ?? process.cwd()): AutomodeStatus {
    const { mode } = this.config(cwd);
    return { mode, active: mode !== "off" };
  }
}
