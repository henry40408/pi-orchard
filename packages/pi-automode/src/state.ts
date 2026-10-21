import { join } from "node:path";
import { loadConfig, type LoadedConfig } from "./config/load.ts";
import { MODES, type Config, type Mode } from "./config/schema.ts";

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

/**
 * The config of the running session. It is read again for a new working
 * directory and on `reload`. `setMode` changes the mode for this session only;
 * only `reload` clears it, so a change of directory cannot undo it.
 */
export class AutomodeState {
  #agentDir: string;
  #cwd: string | undefined;
  #loaded: LoadedConfig | undefined;
  #modeOverride: Mode | undefined;
  #parentMode: Mode | undefined;

  constructor(agentDir: string, parentMode?: Mode) {
    this.#agentDir = agentDir;
    this.#parentMode = parentMode;
  }

  reload(cwd: string): LoadedConfig {
    this.#modeOverride = undefined;
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
    const chosen = errors.length === 0 && this.#modeOverride ? this.#modeOverride : config.mode;
    const mode = this.#parentMode ? stricterMode(chosen, this.#parentMode) : chosen;
    return mode === config.mode ? config : { ...config, mode };
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
    if (this.#ensureLoaded(cwd).errors.length > 0) return "A config file is invalid. Fix it and run /automode reload first.";
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
