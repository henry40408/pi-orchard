/** Removes control characters (including ESC) except tab, so output cannot draw on the terminal. */
export function stripControlCharacters(line: string): string {
  return line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/** Turns a stream of text chunks into whole lines. */
export class LineSplitter {
  #pending = "";
  readonly #maxPendingChars: number;

  /** Output without a newline (a progress bar, binary data) is cut into lines of this size, so the buffer stays small. */
  constructor(maxPendingChars: number) {
    this.#maxPendingChars = maxPendingChars;
  }

  push(chunk: string): string[] {
    this.#pending += chunk;
    const lines = this.#pending.split("\n");
    this.#pending = lines.pop() ?? "";
    while (this.#pending.length > this.#maxPendingChars) {
      lines.push(this.#pending.slice(0, this.#maxPendingChars));
      this.#pending = this.#pending.slice(this.#maxPendingChars);
    }
    return lines.map((line) => line.replace(/\r$/, ""));
  }

  /** Returns the last line when the stream ends without a newline. */
  flush(): string[] {
    const rest = this.#pending.replace(/\r$/, "");
    this.#pending = "";
    return rest === "" ? [] : [rest];
  }
}

export interface LineFilterOptions {
  include: string | undefined;
  exclude: string | undefined;
}

/** Compiles the filter once. An invalid regex is an error for the caller to show. */
export function compileLineFilter(options: LineFilterOptions): ((line: string) => boolean) | { error: string } {
  const include = compile("include", options.include);
  if ("error" in include) return include;
  const exclude = compile("exclude", options.exclude);
  if ("error" in exclude) return exclude;
  return (line) => {
    if (include.regex && !include.regex.test(line)) return false;
    if (exclude.regex?.test(line)) return false;
    return true;
  };
}

function compile(name: string, source: string | undefined): { regex: RegExp | undefined } | { error: string } {
  if (source === undefined || source === "") return { regex: undefined };
  try {
    return { regex: new RegExp(source) };
  } catch (error) {
    return { error: `The ${name} pattern is not a valid regex: ${(error as Error).message}` };
  }
}

export function truncateLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  return `${line.slice(0, maxChars)}… [${line.length - maxChars} more characters]`;
}
