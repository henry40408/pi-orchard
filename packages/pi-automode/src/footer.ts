import type { AutomodeState } from "./state.ts";

export const FOOTER_KEY = "automode";

/**
 * The footer shows only this text, never the key, so the text names itself.
 * Why `OFF` and the error are louder than a plain mode: they are the two
 * states where the user may believe a guard is on when it is not.
 */
export function footerText(state: AutomodeState, cwd: string): string {
  const { mode, active } = state.status(cwd);
  if (state.problems(cwd).errors.length > 0) return `automode: ${mode} (config error)`;
  return active ? `automode: ${mode}` : "automode: OFF";
}
