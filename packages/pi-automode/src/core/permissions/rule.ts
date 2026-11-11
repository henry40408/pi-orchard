/** A permission rule is `tool` or `tool(specifier)`, e.g. `read` or `bash(git push:*)`. */
export const RULE_PATTERN = "^[A-Za-z_][\\w.-]*(\\(.+\\))?$";

export interface Rule {
  /** The rule exactly as written in the config. */
  raw: string;
  tool: string;
  specifier?: string;
}

const RULE_REGEXP = /^([A-Za-z_][\w.-]*)(?:\((.+)\))?$/;

export function parseRule(raw: string): Rule {
  const match = RULE_REGEXP.exec(raw);
  if (!match) throw new Error(`Invalid permission rule: ${raw}`);
  // Lower-case: `Read(./.env)` would otherwise silently never match pi's `read` tool.
  return { raw, tool: match[1]!.toLowerCase(), specifier: match[2] };
}
