export const FOOTER_KEY = "monitor";

/**
 * The text has no "<key>:" and no trailing "(...)": statusline extensions cut both.
 * It starts with an emoji, which they take as the icon.
 * It is always shown, so the user can see that pi-monitor is loaded.
 */
export function footerText(runningCount: number): string {
  return runningCount > 0 ? `👁️ ${runningCount} watching` : "👁️ idle";
}
