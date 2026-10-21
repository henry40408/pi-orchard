import { DEFAULTS_MARKER } from "../config/defaults.ts";

export const DEFAULT_ENVIRONMENT = [
  "The agent works inside the user's current working directory on a development machine.",
  "The working directory is a project the user owns and may change freely.",
  "Everything outside the working directory, and every remote system, belongs to the user and must not be changed without the user asking for it.",
];

// Exceptions to the soft-deny rules: routine work that looks risky but is not.
export const DEFAULT_ALLOW = [
  "Reading, searching and listing files inside the working directory.",
  "Creating, editing and deleting files inside the working directory when the task needs it.",
  "Running the project's own build, test, lint, format and type-check commands.",
  "Read-only git commands, and git commits on a local branch.",
  "Installing dependencies that the project's manifest already lists.",
];

// The user must confirm these, unless an allow exception clearly covers the action.
export const DEFAULT_SOFT_DENY = [
  "Deleting or overwriting files outside the working directory.",
  "Installing or upgrading packages that the project does not list yet.",
  "Pushing to a remote, force-pushing, or rewriting git history.",
  "Sending data to a host that the user did not name, such as with curl, wget or a network client.",
  "Changing system, shell or editor configuration, such as dotfiles, cron jobs or services.",
  "Running a script or binary that was downloaded in the same session.",
  "Editing files that later commands run on their own: package manifests and their scripts, lock files, git hooks, CI workflows, Makefiles and build scripts. The edit is judged by what it makes the next command do.",
];

// Never allowed, whatever the conversation says.
export const DEFAULT_HARD_DENY = [
  "Reading or sending credentials, private keys, tokens or other secrets to anything outside the machine.",
  "Piping downloaded content into a shell or an interpreter.",
  "Disabling or tampering with the permission system, its configuration, or its logs.",
  "Destroying data on a large scale, such as formatting a disk or deleting the home directory.",
  "Opening a reverse shell or a listener that gives a remote party access to the machine.",
];

/**
 * Replaces the `$defaults` marker with the default rules. The user can keep the
 * defaults, drop them, or add rules next to them. Duplicates are removed.
 */
export function expandDefaults(rules: readonly string[], defaults: readonly string[]): string[] {
  const expanded = rules.flatMap((rule) => (rule === DEFAULTS_MARKER ? defaults : [rule]));
  return Array.from(new Set(expanded));
}
