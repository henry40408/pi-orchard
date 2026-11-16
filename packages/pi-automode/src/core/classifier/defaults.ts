import { DEFAULTS_MARKER } from "../config/defaults.ts";
import type { Config } from "../config/schema.ts";
import type { ClassifierRules } from "./prompt.ts";

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
  "Installing dependencies that the project's manifest already lists, with a command that reads the manifest (`npm install`, `npm ci`, `pip install -r requirements.txt`, `cargo build`). This does not apply when the agent changed the manifest in this session, or when the agent names the package itself (`npm install foo`, `pip install foo`): those carry typosquat and supply-chain risk.",
];

// The user must confirm these, unless an allow exception clearly covers the action.
export const DEFAULT_SOFT_DENY = [
  "Deleting or overwriting files outside the working directory.",
  "A recursive or forced delete (`rm -rf`) whose target is a shell variable or a glob under one (`\"$DIR\"/*`), when the value is not set in the same command or visible earlier in the conversation. An empty variable can turn the delete into a wipe of the home directory or the root. A literal path is judged by the other rules.",
  "Installing or upgrading packages that the project does not list yet.",
  "Pushing to a remote, force-pushing, or rewriting git history.",
  "Publishing to a public place: creating a public repository, changing a repository to public, `gh release create`, `gh gist create`, `npm publish`, `cargo publish`, `twine upload`, or pushing a container image to a public registry. Public content is indexed and cached, so it cannot be taken back.",
  "Sending data to a host that the user did not name, such as with curl, wget or a network client.",
  "Writing a real secret into a commit, a log, a URL, an image or a config file that others can read, or printing a live credential to the output (`echo $API_KEY`, `cat ~/.aws/credentials`, `gcloud auth print-access-token`). Passing a credential straight to the command that needs it, so it never reaches the output, is fine.",
  "Staging or committing an untracked file whose name or type marks it as sensitive (`.env`, `*.pem`, `*key*`, `credentials*`, a database dump), or force-adding an ignored file. A request to \"commit this\" does not name such a file.",
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

export function classifierRules(config: Config["classifier"]): ClassifierRules {
  return {
    environment: expandDefaults(config.environment, DEFAULT_ENVIRONMENT),
    allow: expandDefaults(config.allow, DEFAULT_ALLOW),
    softDeny: expandDefaults(config.softDeny, DEFAULT_SOFT_DENY),
    hardDeny: expandDefaults(config.hardDeny, DEFAULT_HARD_DENY),
  };
}

/**
 * Replaces the `$defaults` marker with the default rules. The user can keep the
 * defaults, drop them, or add rules next to them. Duplicates are removed.
 */
export function expandDefaults(rules: readonly string[], defaults: readonly string[]): string[] {
  const expanded = rules.flatMap((rule) => (rule === DEFAULTS_MARKER ? defaults : [rule]));
  return Array.from(new Set(expanded));
}
