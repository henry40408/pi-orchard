import type { Config, ConfigFile, Mode } from "./schema.ts";

// Higher is stricter. rules never calls the classifier, so it is stricter than auto.
const MODE_STRICTNESS: Record<Mode, number> = { off: 0, auto: 1, rules: 2, ask: 3 };

export interface MergeResult {
  config: Config;
  /** Project-layer fields that tried to loosen the user layer or are not allowed there. */
  ignored: string[];
}

function union(base: string[], extra: string[] = []): string[] {
  return [...new Set([...base, ...extra])];
}

/**
 * Layers the project config over the user config, tightening only.
 * Why: the project file comes from a possibly untrusted repo, so it must not
 * allow anything the user did not allow.
 */
export function applyProjectConfig(user: Config, project: ConfigFile): MergeResult {
  const ignored: string[] = [];
  const config: Config = structuredClone(user);

  if (project.mode !== undefined) {
    if (MODE_STRICTNESS[project.mode] >= MODE_STRICTNESS[user.mode]) {
      config.mode = project.mode;
    } else {
      ignored.push("mode");
    }
  }

  if (project.allowInsideWorkingDirectory === true && !user.allowInsideWorkingDirectory) {
    ignored.push("allowInsideWorkingDirectory");
  }
  config.allowInsideWorkingDirectory =
    user.allowInsideWorkingDirectory && project.allowInsideWorkingDirectory !== false;

  config.permissions.ask = union(user.permissions.ask, project.permissions?.ask);
  config.permissions.deny = union(user.permissions.deny, project.permissions?.deny);
  if (project.permissions?.allow) ignored.push("permissions.allow");

  const projectClassifier = project.classifier;
  if (projectClassifier?.enabled === true && !user.classifier.enabled) {
    ignored.push("classifier.enabled");
  }
  config.classifier.enabled = user.classifier.enabled && projectClassifier?.enabled !== false;
  config.classifier.softDeny = union(user.classifier.softDeny, projectClassifier?.softDeny);
  config.classifier.hardDeny = union(user.classifier.hardDeny, projectClassifier?.hardDeny);

  // The remaining fields change where data is sent, the cost, or what the
  // classifier judges by, so only the user layer may set them.
  const userOnlyFields = [
    "model",
    "reasoningLevel",
    "timeoutMs",
    "context",
    "environment",
    "allow",
  ] as const;
  for (const field of userOnlyFields) {
    if (projectClassifier?.[field] !== undefined) ignored.push(`classifier.${field}`);
  }
  if (project.log) ignored.push("log");

  return { config, ignored };
}
