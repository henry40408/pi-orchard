export interface BashSplit {
  /** Every simple command found, including those nested in $(...), backticks and subshells. */
  segments: string[];
  /**
   * False when the command cannot be fully analysed: unbalanced quotes or
   * substitutions, or output redirected to a file. Such a command must never
   * be allowed by a prefix rule.
   */
  complete: boolean;
}

// Redirect targets that do not write to a file.
const HARMLESS_REDIRECT_TARGETS = new Set(["/dev/null"]);
const SEPARATORS = new Set([";", "\n", "|", "&"]);
const WORD_END = /[\s;|&()<>]/;
// A `#` only starts a comment here; elsewhere we over-analyse, which is safe.
const COMMENT_START_PREDECESSOR = /[\s;|&(]/;
// Real commands never nest this deep; refusing to analyse bounds the recursion.
const MAX_NESTING_DEPTH = 50;

/**
 * Splits a shell command into the simple commands it runs.
 * Why: a rule like `bash(ls:*)` must not allow `ls && rm -rf /`, and
 * `bash(rm -rf:*)` must still deny `echo $(rm -rf /)`.
 */
export function splitBashCommand(command: string): BashSplit {
  const segments: string[] = [];
  let complete = true;

  // Scans from `start` up to `closer` (or the end); returns the index after it.
  function scan(start: number, closer: ")" | "`" | null, depth: number): number {
    if (depth > MAX_NESTING_DEPTH) {
      complete = false;
      const rest = command.slice(start).trim();
      if (rest) segments.push(rest);
      return command.length;
    }
    let current = "";
    const flush = () => {
      const segment = current.trim();
      if (segment) segments.push(segment);
      current = "";
    };
    // Scans a nested construct and keeps its original text in the current segment.
    const appendNested = (from: number, bodyStart: number, nestedCloser: ")" | "`") => {
      const end = scan(bodyStart, nestedCloser, depth + 1);
      current += command.slice(from, end);
      return end;
    };

    // ${...} may hold quotes, `#` and other text we do not parse, so the command can never be allowed.
    const appendParameterExpansion = (from: number) => {
      complete = false;
      let depthOfBraces = 0;
      let end = from;
      for (; end < command.length; end++) {
        if (command[end] === "{") depthOfBraces++;
        else if (command[end] === "}" && --depthOfBraces === 0) break;
      }
      const stop = Math.min(end + 1, command.length);
      current += command.slice(from, stop);
      return stop;
    };

    let i = start;
    let lastDollar = -1;
    let escapeEnd = -1;
    while (i < command.length) {
      const ch = command[i]!;

      if (ch === closer) {
        flush();
        return i + 1;
      }
      if (ch === "\\") {
        // Backticks nested as \` are re-parsed by bash; we do not analyse them.
        if (closer === "`" && command[i + 1] === "`") complete = false;
        current += command.slice(i, i + 2);
        i += 2;
        escapeEnd = i;
      } else if (ch === "'") {
        // $'...' is ANSI-C quoting, where \' does not end the string.
        const end = lastDollar === i - 1 ? findAnsiCQuoteEnd(command, i + 1) : command.indexOf("'", i + 1);
        if (end === -1) {
          complete = false;
          current += command.slice(i);
          i = command.length;
        } else {
          current += command.slice(i, end + 1);
          i = end + 1;
        }
      } else if (ch === '"') {
        current += ch;
        i++;
        while (i < command.length && command[i] !== '"') {
          if (command[i] === "\\") {
            current += command.slice(i, i + 2);
            i += 2;
          } else if (command.startsWith("${", i)) {
            i = appendParameterExpansion(i);
          } else if (command.startsWith("$(", i)) {
            i = appendNested(i, i + 2, ")");
          } else if (command[i] === "`") {
            i = appendNested(i, i + 1, "`");
          } else {
            current += command[i];
            i++;
          }
        }
        if (i >= command.length) {
          complete = false;
        } else {
          current += '"';
          i++;
        }
      } else if (command.startsWith("${", i)) {
        i = appendParameterExpansion(i);
      } else if (command.startsWith("$$", i)) {
        // $$ is the process ID; the next character is not part of a $'...' string.
        current += "$$";
        i += 2;
      } else if (command.startsWith("<<<", i)) {
        current += "<<<";
        i += 3;
      } else if (command.startsWith("<<", i)) {
        // Here-document bodies are not analysed; their quotes would desync the scanner.
        complete = false;
        current += "<<";
        i += 2;
      } else if (/^[$<>]\(/.test(command.slice(i, i + 2))) {
        // $(...) command substitution, <(...) and >(...) process substitution.
        i = appendNested(i, i + 2, ")");
      } else if (ch === "`") {
        i = appendNested(i, i + 1, "`");
      } else if (ch === "(") {
        flush();
        i = scan(i + 1, ")", depth + 1);
      } else if (ch === ")") {
        complete = false;
        flush();
        i++;
      } else if (ch === ">") {
        const redirect = readOutputRedirect(command, i);
        if (!redirect.harmless) complete = false;
        current += command.slice(i, redirect.end);
        i = redirect.end;
      } else if (command.startsWith(";;", i)) {
        // A case pattern's `)` would be misread as the end of the enclosing construct.
        complete = false;
        flush();
        i += 2;
      } else if (SEPARATORS.has(ch)) {
        flush();
        i++;
      } else if (
        ch === "#" &&
        escapeEnd !== i &&
        (i === 0 || COMMENT_START_PREDECESSOR.test(command[i - 1]!))
      ) {
        const newline = command.indexOf("\n", i);
        i = newline === -1 ? command.length : newline;
      } else {
        if (ch === "$") lastDollar = i;
        current += ch;
        i++;
      }
    }

    if (closer !== null) complete = false;
    flush();
    return i;
  }

  scan(0, null, 0);
  return { segments, complete };
}

function findAnsiCQuoteEnd(command: string, from: number): number {
  for (let i = from; i < command.length; i++) {
    if (command[i] === "\\") i++;
    else if (command[i] === "'") return i;
  }
  return -1;
}

function readOutputRedirect(command: string, start: number): { end: number; harmless: boolean } {
  let i = start + 1;
  if (command[i] === ">" || command[i] === "|") i++;

  // File descriptor duplication such as 2>&1 or >&2.
  const duplicate = /^&(?:\d+|-)(?=$|[\s;|&()<>])/.exec(command.slice(i));
  if (duplicate) return { end: i + duplicate[0].length, harmless: true };

  while (command[i] === " " || command[i] === "\t") i++;
  const targetStart = i;
  while (i < command.length && !WORD_END.test(command[i]!)) i++;
  const target = command.slice(targetStart, i);
  return { end: i, harmless: HARMLESS_REDIRECT_TARGETS.has(target) };
}

const SHELL_KEYWORDS = "\\{|!|if|then|elif|else|do|while|until|time|function\\s+\\S+";
const ASSIGNMENT =
  "[A-Za-z_][A-Za-z0-9_]*(?:\\[[^\\]]*\\])?\\+?=" +
  "(?:\\\\.|\"(?:[^\"\\\\]|\\\\.)*\"|'[^']*'|\\$\\([^)]*\\)|[^\\s\"'\\\\])*";
const REDIRECT = "\\d*(?:&>>?|[<>]{1,2}[&|]?)\\s*\\S+";
const LEADING_NOISE = new RegExp(`^(?:(?:${ASSIGNMENT}|${REDIRECT}|${SHELL_KEYWORDS})\\s+)+`);

function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * The forms of a segment that deny and ask rules are tested against: as
 * written, without leading `VAR=value` assignments or shell keywords
 * (`FOO=1 rm -rf x`, `then rm -rf x`), and with quotes and backslashes removed
 * (`'rm' -rf x`). Allow rules only use the written form, because stripping
 * would let `PATH=/evil ls` pass as `ls`.
 */
export function bashBlockForms(segment: string): string[] {
  // A backslash-newline is a line continuation: bash removes it before running the command.
  const written = collapseWhitespace(segment.replace(/\\\n/g, ""));
  const stripped = written.replace(LEADING_NOISE, "");
  const unquote = (form: string) => form.replace(/['"\\]/g, "");
  return [...new Set([written, stripped, unquote(written), unquote(stripped)])];
}

export function bashAllowForms(segment: string): string[] {
  return [collapseWhitespace(segment)];
}

/** `cmd` matches exactly; `cmd:*` matches `cmd` and anything starting with `cmd `. */
export function matchesBashSpecifier(form: string, specifier: string): boolean {
  if (!specifier.endsWith(":*")) return form === collapseWhitespace(specifier);
  const prefix = collapseWhitespace(specifier.slice(0, -2));
  return form === prefix || form.startsWith(`${prefix} `);
}
