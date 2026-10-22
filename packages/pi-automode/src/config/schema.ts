import Type from "typebox";
import { RULE_PATTERN } from "../permissions/rule.ts";

export const MODES = ["auto", "rules", "ask", "off"] as const;
export const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

const RuleList = Type.Array(Type.String({ minLength: 1 }));
// A malformed permission rule must be an error, not a rule that silently never matches.
const PermissionRuleList = Type.Array(Type.String({ pattern: RULE_PATTERN }));

// A Union built directly from a .map result loses the literal types in TypeBox.
function oneOf<T extends string>(values: readonly T[]) {
  return Type.Unsafe<T>(Type.Union(values.map((value) => Type.Literal(value))));
}

// additionalProperties: false makes a misspelled key (e.g. "dney") an error instead of silently doing nothing.
export const ConfigFileSchema = Type.Object(
  {
    mode: Type.Optional(oneOf(MODES)),
    allowInsideWorkingDirectory: Type.Optional(Type.Boolean()),
    permissions: Type.Optional(
      Type.Object(
        {
          allow: Type.Optional(PermissionRuleList),
          ask: Type.Optional(PermissionRuleList),
          deny: Type.Optional(PermissionRuleList),
        },
        { additionalProperties: false },
      ),
    ),
    classifier: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          model: Type.Optional(Type.String({ pattern: "^[^/\\s]+/\\S+$" })),
          reasoningLevel: Type.Optional(oneOf(REASONING_LEVELS)),
          timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600000 })),
          context: Type.Optional(
            Type.Object(
              {
                userTokens: Type.Optional(Type.Integer({ minimum: 0 })),
                toolTokens: Type.Optional(Type.Integer({ minimum: 0 })),
              },
              { additionalProperties: false },
            ),
          ),
          environment: Type.Optional(RuleList),
          allow: Type.Optional(RuleList),
          softDeny: Type.Optional(RuleList),
          hardDeny: Type.Optional(RuleList),
        },
        { additionalProperties: false },
      ),
    ),
    log: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          classifierIo: Type.Optional(Type.Boolean()),
          maxFileBytes: Type.Optional(Type.Integer({ minimum: 1_048_576, maximum: 1_073_741_824 })),
          keepDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
          keepFiles: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type ConfigFile = Type.Static<typeof ConfigFileSchema>;
export type Mode = (typeof MODES)[number];
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** A config with every field filled in from the defaults. */
export interface Config {
  mode: Mode;
  allowInsideWorkingDirectory: boolean;
  permissions: { allow: string[]; ask: string[]; deny: string[] };
  classifier: {
    enabled: boolean;
    /** When unset, the current session's model is used. */
    model?: string;
    reasoningLevel: ReasoningLevel;
    timeoutMs: number;
    context: { userTokens: number; toolTokens: number };
    environment: string[];
    allow: string[];
    softDeny: string[];
    hardDeny: string[];
  };
  log: {
    enabled: boolean;
    /** Also log the classifier's prompt and reply. They hold conversation text. */
    classifierIo: boolean;
    /** A log file that grows past this is renamed to `<name>.1`, and a new one starts. */
    maxFileBytes: number;
    /** Log files older than this are deleted when a session starts. */
    keepDays: number;
    /** At most this many log files are kept. */
    keepFiles: number;
  };
}
