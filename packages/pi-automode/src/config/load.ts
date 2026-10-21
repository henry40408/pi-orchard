import { readFileSync, statSync } from "node:fs";
import Value from "typebox/value";
import { resolveConfig } from "./defaults.ts";
import { applyProjectConfig } from "./merge.ts";
import { type Config, type ConfigFile, ConfigFileSchema } from "./schema.ts";

type ReadResult =
  | { status: "missing" }
  | { status: "ok"; file: ConfigFile }
  | { status: "invalid"; errors: string[] };

export interface LoadedConfig {
  config: Config;
  /** 設定檔無效時不為空；此時 mode 會被強制為 "ask"。 */
  errors: string[];
  /** 專案層被忽略的項目，需要告知使用者。 */
  ignored: string[];
}

// 專案層來自不受信任的 repo：FIFO 或 /dev/zero 的 symlink 會讓 readFileSync 卡死。
const MAX_CONFIG_BYTES = 1024 * 1024;

// 無效檔案裡的 deny 規則也不會生效，必須讓使用者知道。
const UNUSED_RULES_NOTICE = (path: string) =>
  `${path}: 檔案無效，其中所有規則（含 deny）都未生效，mode 已強制為 ask`;

export function readConfigFile(path: string): ReadResult {
  let text: string;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return { status: "invalid", errors: [`${path}: 不是一般檔案`] };
    if (stats.size > MAX_CONFIG_BYTES) {
      return { status: "invalid", errors: [`${path}: 檔案超過 ${MAX_CONFIG_BYTES} bytes`] };
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "invalid", errors: [`${path}: ${(error as Error).message}`] };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { status: "invalid", errors: [`${path}: ${(error as Error).message}`] };
  }

  if (Value.Check(ConfigFileSchema, json)) return { status: "ok", file: json };
  const errors = [...Value.Errors(ConfigFileSchema, json)].map(
    (error) => `${path}: ${error.instancePath || "/"} ${error.message}`,
  );
  return { status: "invalid", errors };
}

export function loadConfig(paths: { user: string; project: string }): LoadedConfig {
  const errors: string[] = [];
  const user = readConfigFile(paths.user);
  const project = readConfigFile(paths.project);
  if (user.status === "invalid") errors.push(...user.errors, UNUSED_RULES_NOTICE(paths.user));
  if (project.status === "invalid") {
    errors.push(...project.errors, UNUSED_RULES_NOTICE(paths.project));
  }

  let config = resolveConfig(user.status === "ok" ? user.file : {});
  let ignored: string[] = [];
  if (project.status === "ok") ({ config, ignored } = applyProjectConfig(config, project.file));

  // 無法確認使用者的意圖時，寧可全部詢問。
  if (errors.length > 0) config.mode = "ask";
  return { config, errors, ignored };
}
