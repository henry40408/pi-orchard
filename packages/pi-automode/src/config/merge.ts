import type { Config, ConfigFile, Mode } from "./schema.ts";

// 越大越嚴格。rules 不會呼叫分類器，所以比 auto 嚴格。
const MODE_STRICTNESS: Record<Mode, number> = { off: 0, auto: 1, rules: 2, ask: 3 };

export interface MergeResult {
  config: Config;
  /** 專案層試圖放寬或不允許設定的項目。 */
  ignored: string[];
}

function union(base: string[], extra: string[] = []): string[] {
  return [...new Set([...base, ...extra])];
}

/**
 * 把專案層疊在使用者層上，只允許收緊。
 * 原因：專案設定檔來自可能不受信任的 repo，不能讓它放行使用者沒放行的動作。
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

  // 其餘欄位會改變資料送往何處、成本或分類器的判斷依據，只接受使用者層。
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
