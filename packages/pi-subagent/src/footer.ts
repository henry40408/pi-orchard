export const FOOTER_KEY = "subagent";

/**
 * The text has no "<key>:" and no trailing "(...)": statusline extensions cut both.
 * It starts with an emoji, which they take as the icon.
 * It is always shown, so the user can see that pi-subagent is loaded.
 */
export function footerText(runningCount: number): string {
  return runningCount > 0 ? `🤖 ${runningCount} running` : "🤖 idle";
}
