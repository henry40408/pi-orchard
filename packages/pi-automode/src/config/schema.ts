import Type from "typebox";

export const MODES = ["auto", "rules", "ask", "off"] as const;
export const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

const RuleList = Type.Array(Type.String({ minLength: 1 }));

// 直接對 .map 的結果建 Union 會讓 TypeBox 推不出字面型別。
function oneOf<T extends string>(values: readonly T[]) {
  return Type.Unsafe<T>(Type.Union(values.map((value) => Type.Literal(value))));
}

// additionalProperties: false 讓拼錯的 key 直接報錯，而不是默默失效（例如 "dney"）。
export const ConfigFileSchema = Type.Object(
  {
    mode: Type.Optional(oneOf(MODES)),
    allowInsideWorkingDirectory: Type.Optional(Type.Boolean()),
    permissions: Type.Optional(
      Type.Object(
        {
          allow: Type.Optional(RuleList),
          ask: Type.Optional(RuleList),
          deny: Type.Optional(RuleList),
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
          timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
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

/** 所有欄位都已補上預設值的設定。 */
export interface Config {
  mode: Mode;
  allowInsideWorkingDirectory: boolean;
  permissions: { allow: string[]; ask: string[]; deny: string[] };
  classifier: {
    enabled: boolean;
    /** 未設定時使用目前 session 的模型。 */
    model?: string;
    reasoningLevel: ReasoningLevel;
    timeoutMs: number;
    context: { userTokens: number; toolTokens: number };
    environment: string[];
    allow: string[];
    softDeny: string[];
    hardDeny: string[];
  };
  log: { enabled: boolean; classifierIo: boolean };
}
