/** The part of a session entry that the classifier reads. */
export interface ContextEntry {
  type: string;
  message?: { role?: string; content?: unknown; toolName?: string };
}

export interface ToolResultSnippet {
  toolName: string;
  text: string;
}

export interface ConversationContext {
  /** What the user said, oldest first. */
  userMessages: string[];
  /** What tools returned, oldest first. Untrusted: a file or a web page can say anything. */
  toolResults: ToolResultSnippet[];
}

export interface ContextBudget {
  userTokens: number;
  toolTokens: number;
}

const CHARACTERS_PER_TOKEN = 4;
const TRUNCATION_MARK = "…[truncated]";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

// Newest first, so the budget is spent on what is most recent.
function takeWithinBudget<T>(newestFirst: T[], tokens: number, lengthOf: (item: T) => number, cut: (item: T, length: number) => T): T[] {
  const taken: T[] = [];
  let remaining = tokens * CHARACTERS_PER_TOKEN;
  for (const item of newestFirst) {
    if (remaining <= 0) break;
    const length = lengthOf(item);
    taken.push(length <= remaining ? item : cut(item, remaining));
    remaining -= length;
  }
  return taken.reverse();
}

function cutText(text: string, length: number): string {
  // Do not end on half of a surrogate pair.
  const end = /[\ud800-\udbff]/.test(text[length - 1] ?? "") ? length - 1 : length;
  return text.slice(0, end) + TRUNCATION_MARK;
}

// pi expands `/skill:name` into a user message. A project can ship its own skills,
// so their text is repo-controlled and must not count as what the user said.
const SKILL_BLOCK = /<skill\b[^>]*>[\s\S]*?(?:<\/skill>|$)/g;

function withoutSkillBlocks(text: string): string {
  return text.replace(SKILL_BLOCK, "[skill text omitted]").trim();
}

/**
 * Picks the recent user messages and tool results that fit the token budgets.
 * Assistant messages are left out: the model under judgement wrote them, so
 * they must not vouch for its own action.
 * `entries` must be the current branch (`getBranch()`), not `getEntries()`:
 * a message on an abandoned branch is not consent for this one.
 */
export function collectConversation(entries: readonly ContextEntry[], budget: ContextBudget): ConversationContext {
  const messages = entries
    .filter((entry) => entry.type === "message" && entry.message !== undefined)
    .map((entry) => entry.message!)
    .reverse();

  const users = messages
    .filter((message) => message.role === "user")
    .map((message) => withoutSkillBlocks(textOf(message.content)))
    .filter((text) => text !== "");
  const tools = messages
    .filter((message) => message.role === "toolResult")
    .map((message) => ({ toolName: message.toolName ?? "unknown", text: textOf(message.content) }))
    .filter((snippet) => snippet.text !== "");

  return {
    userMessages: takeWithinBudget(users, budget.userTokens, (text) => text.length, cutText),
    toolResults: takeWithinBudget(
      tools,
      budget.toolTokens,
      (snippet) => snippet.text.length,
      (snippet, length) => ({ ...snippet, text: cutText(snippet.text, length) }),
    ),
  };
}
