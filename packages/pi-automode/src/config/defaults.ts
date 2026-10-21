import type { Config, ConfigFile } from "./schema.ts";

// "$defaults" 的內容由分類器階段展開，這裡只保留標記。
export const DEFAULTS_MARKER = "$defaults";

export const DEFAULT_CONFIG: Config = {
  mode: "auto",
  allowInsideWorkingDirectory: false,
  permissions: { allow: [], ask: [], deny: [] },
  classifier: {
    enabled: true,
    reasoningLevel: "low",
    timeoutMs: 20000,
    context: { userTokens: 4000, toolTokens: 4000 },
    environment: [DEFAULTS_MARKER],
    allow: [DEFAULTS_MARKER],
    softDeny: [DEFAULTS_MARKER],
    hardDeny: [DEFAULTS_MARKER],
  },
  log: { enabled: false, classifierIo: false },
};

/** 把設定檔內容疊在預設值上。 */
export function resolveConfig(file: ConfigFile): Config {
  const base = structuredClone(DEFAULT_CONFIG);
  return {
    mode: file.mode ?? base.mode,
    allowInsideWorkingDirectory:
      file.allowInsideWorkingDirectory ?? base.allowInsideWorkingDirectory,
    permissions: { ...base.permissions, ...file.permissions },
    classifier: {
      ...base.classifier,
      ...file.classifier,
      context: { ...base.classifier.context, ...file.classifier?.context },
    },
    log: { ...base.log, ...file.log },
  };
}
