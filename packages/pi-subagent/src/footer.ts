export const FOOTER_KEY = "subagent";

/**
 * The text has no "<key>:" and no trailing "(...)": statusline extensions cut both.
 * It starts with an emoji, which they take as the icon. Undefined clears the footer entry.
 */
export function footerText(runningCount: number): string | undefined {
  return runningCount > 0 ? `🤖 ${runningCount} running` : undefined;
}
