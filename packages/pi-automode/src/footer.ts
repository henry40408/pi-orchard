import type { AutomodeState } from "./state.ts";

export const FOOTER_KEY = "automode";

const GUARDED_ICON = "🛡️";
const WARNING_ICON = "⚠️";

/**
 * The footer shows only this text, never the key. Statusline extensions
 * rewrite it further: they cut a leading "<key>:", take a leading emoji as the
 * icon (else add their own), and drop a trailing "(...)". So the text starts
 * with an emoji, keeps "automode:" after it, and has no trailing parentheses.
 * `OFF` and the error get the warning icon: they are the two states where the
 * user may believe a guard is on when it is not.
 */
export function footerText(state: AutomodeState, cwd: string): string {
  const { mode, active } = state.status(cwd);
  if (state.problems(cwd).errors.length > 0) return `${WARNING_ICON} automode: ${mode} · config error`;
  return active ? `${GUARDED_ICON} automode: ${mode}` : `${WARNING_ICON} automode: OFF`;
}
