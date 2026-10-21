import { join } from "node:path";
import { loadConfig, type LoadedConfig } from "./config/load.ts";
import { MODES, type Config, type Mode } from "./config/schema.ts";
import { RULE_PATTERN } from "./permissions/rule.ts";

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

// From loosest to strictest. `rules` is stricter than `auto` because it never lets the classifier allow.
const MODE_STRICTNESS: readonly Mode[] = ["off", "auto", "rules", "ask"];

export function stricterMode(first: Mode, second: Mode): Mode {
  return MODE_STRICTNESS.indexOf(first) >= MODE_STRICTNESS.indexOf(second) ? first : second;
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
  #parentMode: Mode | undefined;

  constructor(agentDir: string, parentMode?: Mode) {
    this.#agentDir = agentDir;
    this.#parentMode = parentMode;
  }

  reload(cwd: string): LoadedConfig {
    this.#modeOverride = undefined;
    this.#sessionRules = { allow: [], ask: [], deny: [] };
    this.#classifierOverride = {};
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
    });
  }

  #withParentFloor(config: Config): Config {
    if (!this.#parentMode) return config;
    const mode = stricterMode(config.mode, this.#parentMode);
    return mode === config.mode ? config : { ...config, mode };
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
    if (!this.#sessionRules[kind].includes(rule)) this.#sessionRules[kind].push(rule);
    return undefined;
  }

  setClassifierEnabled(cwd: string, enabled: boolean): string | undefined {
    const refusal = this.#refusalForInvalidConfig(cwd);
    if (refusal) return refusal;
    this.#classifierOverride.enabled = enabled;
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

  /** Without a directory, the one used last; before any, the process directory. */
  status(cwd: string = this.#cwd ?? process.cwd()): AutomodeStatus {
    const { mode } = this.config(cwd);
    return { mode, active: mode !== "off" };
  }
}
