import { readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PathContext {
  cwd: string;
  home: string;
  /** macOS and Windows file systems ignore case, so `.ENV` is the same file as `.env`. */
  caseInsensitive: boolean;
}

export function createPathContext(cwd: string): PathContext {
  return { cwd, home: homedir(), caseInsensitive: process.platform !== "linux" };
}

const UNICODE_SPACES = /[  -   　]/g;

/**
 * Resolves a tool's path argument the way pi does (see pi's utils/paths.js):
 * Unicode spaces, a leading `@`, `~`, and `file://` URLs. A different result
 * here would let `@.env` slip past a rule written for `.env`.
 */
function resolveToolPath(raw: string, context: PathContext): string {
  let path = raw.replace(UNICODE_SPACES, " ");
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") path = context.home;
  else if (path.startsWith("~/")) path = join(context.home, path.slice(2));
  if (path.startsWith("file://")) {
    try {
      path = fileURLToPath(path);
    } catch {
      // The tool will fail on an invalid URL; keep the text so rules still see it.
    }
  }
  return resolve(context.cwd, path);
}

const MAX_DANGLING_SYMLINK_HOPS = 40;

// realpath of the nearest existing ancestor, plus the part that does not exist yet.
// A symlink whose target is missing is followed too: writing through it creates the target.
function canonicalize(path: string, hops = 0): string {
  const missing: string[] = [];
  let current = path;
  // Each pass moves one directory up, so the loop ends at the root.
  while (current !== dirname(current)) {
    try {
      return join(realpathSync(current), ...missing);
    } catch {
      const target = danglingSymlinkTarget(current);
      if (target !== undefined && hops < MAX_DANGLING_SYMLINK_HOPS) {
        return join(canonicalize(target, hops + 1), ...missing);
      }
      missing.unshift(basename(current));
      current = dirname(current);
    }
  }
  return path;
}

function danglingSymlinkTarget(path: string): string | undefined {
  try {
    // A relative link is resolved against the real directory that holds it, as the OS does.
    return resolve(canonicalize(dirname(path)), readlinkSync(path));
  } catch {
    return undefined;
  }
}

// The working directory and home may be symlinks themselves (/tmp on macOS).
// That is the user's setup, not a link the model followed, so it is not reported.
function withRealBase(path: string, context: PathContext): string {
  for (const base of [context.cwd, context.home]) {
    if (path !== base && !path.startsWith(`${base}/`)) continue;
    return canonicalize(base) + path.slice(base.length);
  }
  return path;
}

/**
 * The real path of `path` when it goes through a symlink, otherwise undefined.
 * The caller tells the model this path instead of following the link, so the
 * model asks again with the real path and the rules judge that path.
 */
export function symlinkTarget(path: string, context: PathContext): string | undefined {
  const normalized = withRealBase(path, context);
  const real = canonicalize(normalized);
  return real === normalized ? undefined : real;
}

export interface PathFormsOptions {
  /** Also add the spellings pi's `read` tool falls back to when the file does not exist. */
  readFallbacks?: boolean;
}

// Mirrors the fallbacks of resolveReadPath in pi (core/tools/path-utils.js).
function readFallbackSpellings(resolved: string): string[] {
  const amPm = resolved.replace(/ (AM|PM)\./gi, " $1.");
  const curly = (text: string) => text.replace(/'/g, "’");
  const nfd = resolved.normalize("NFD");
  return [amPm, nfd, curly(resolved), curly(nfd)].filter((spelling) => spelling !== resolved);
}

/**
 * The absolute paths a tool call may touch: the path as written and, when it
 * differs, the same path with a symlinked working directory or home replaced
 * by its real path. Symlinks inside the path are not followed here; see `symlinkTarget`.
 */
export function pathForms(raw: string, context: PathContext, options: PathFormsOptions = {}): string[] {
  const written = resolveToolPath(raw, context);
  const spellings = options.readFallbacks ? [written, ...readFallbackSpellings(written)] : [written];
  const forms = new Set<string>();
  for (const spelling of spellings) {
    forms.add(spelling);
    forms.add(withRealBase(spelling, context));
  }
  return [...forms];
}

type Token =
  | { kind: "char"; value: string }
  | { kind: "any-char" } // ?
  | { kind: "star" } // * stays inside one segment
  | { kind: "globstar" } // ** crosses directories
  | { kind: "globstar-slash" }; // **/ matches any directories, or none

function foldForMatching(text: string, context: PathContext): string {
  return context.caseInsensitive ? text.normalize("NFC").toLowerCase() : text;
}

function literalTokens(text: string, context: PathContext): Token[] {
  return [...foldForMatching(text, context)].map((value) => ({ kind: "char", value }));
}

function globTokens(glob: string, context: PathContext): Token[] {
  const tokens: Token[] = [];
  const folded = [...foldForMatching(glob, context)];
  for (let i = 0; i < folded.length; i++) {
    const ch = folded[i]!;
    if (ch === "*" && folded[i + 1] === "*") {
      if (folded[i + 2] === "/") {
        tokens.push({ kind: "globstar-slash" });
        i += 2;
      } else {
        tokens.push({ kind: "globstar" });
        i += 1;
      }
    } else if (ch === "*") {
      tokens.push({ kind: "star" });
    } else if (ch === "?") {
      tokens.push({ kind: "any-char" });
    } else {
      tokens.push({ kind: "char", value: ch });
    }
  }
  return tokens;
}

// Glob characters in the base directory itself are literal, not wildcards.
function tokensUnder(base: string, rest: string, context: PathContext): Token[] {
  const resolved = resolve(base, rest);
  if (resolved !== base && !resolved.startsWith(`${base}/`)) return globTokens(resolved, context);
  return [...literalTokens(base, context), ...globTokens(resolved.slice(base.length), context)];
}

// The part of a specifier before its first glob character, cut at a directory
// boundary, with symlinks followed. `from` skips a base that is always literal.
function withRealLiteralPrefix(specifier: string, from = 0): string {
  const glob = specifier.slice(from).search(/[*?[]/);
  const literalEnd = glob === -1 ? specifier.length : specifier.lastIndexOf("/", from + glob);
  if (literalEnd <= 0) return specifier;
  const prefix = specifier.slice(0, literalEnd);
  return canonicalize(prefix) + specifier.slice(prefix.length);
}

// The model is told the real path of a symlink and asks again with it, so a
// rule written with a symlinked path must match the real path too. A
// symlinked working directory (such as /tmp on macOS) is covered the same way.
function specifierTokenSets(specifier: string, context: PathContext): Token[][] {
  if (isAbsolute(specifier)) {
    const resolved = resolve(specifier);
    return [...new Set([resolved, withRealLiteralPrefix(resolved)])].map((path) => globTokens(path, context));
  }
  const underHome = specifier === "~" || specifier.startsWith("~/");
  const base = underHome ? context.home : context.cwd;
  const rest = underHome ? specifier.slice(2) : specifier;
  const realBase = canonicalize(base);
  const sets = [...new Set([base, realBase])].map((candidate) => tokensUnder(candidate, rest, context));

  const resolved = resolve(base, rest);
  if (resolved !== base && !resolved.startsWith(`${base}/`)) return sets;
  const realized = withRealLiteralPrefix(resolved, base.length);
  if (realized === resolved) return sets;
  if (realized !== realBase && !realized.startsWith(`${realBase}/`)) return [...sets, globTokens(realized, context)];
  return [...sets, tokensUnder(realBase, realized.slice(realBase.length + 1), context)];
}

/**
 * Runs the tokens over `path` without backtracking, so a hostile path cannot
 * cause exponential work. Returns the positions reachable after each token.
 */
function reachableAfterEachToken(path: string[], tokens: Token[]): Uint8Array[] {
  const end = path.length;
  let reach = new Uint8Array(end + 1);
  reach[0] = 1;
  const steps: Uint8Array[] = [];

  for (const token of tokens) {
    const next = new Uint8Array(end + 1);
    let live = false;
    for (let position = 0; position <= end; position++) {
      const isReached = reach[position] === 1;
      switch (token.kind) {
        case "char":
          if (isReached && path[position] === token.value) next[position + 1] = 1;
          break;
        case "any-char":
          if (isReached && position < end && path[position] !== "/") next[position + 1] = 1;
          break;
        case "star":
          if (isReached) live = true;
          if (live) next[position] = 1;
          if (path[position] === "/") live = false;
          break;
        case "globstar":
          if (isReached) live = true;
          if (live) next[position] = 1;
          break;
        case "globstar-slash":
          if (live && path[position - 1] === "/") next[position] = 1;
          if (isReached) {
            next[position] = 1;
            live = true;
          }
          break;
      }
    }
    reach = next;
    steps.push(reach);
  }
  return steps;
}

/**
 * Matches an absolute path against a glob. `./` and bare patterns are relative
 * to the working directory, `~/` to the home directory. A match on a directory
 * also covers everything inside it.
 */
export function matchesPathSpecifier(path: string, specifier: string, context: PathContext): boolean {
  // Code points, like the tokens, so an astral character is one unit on both sides.
  const folded = [...foldForMatching(path, context)];
  return specifierTokenSets(specifier, context).some((tokens) => {
    const final = reachableAfterEachToken(folded, tokens).at(-1);
    if (!final) return false;
    for (let position = 0; position <= folded.length; position++) {
      if (final[position] && (position === folded.length || folded[position] === "/")) return true;
    }
    return false;
  });
}

/**
 * True when the glob can match something inside the directory `path`. Why:
 * `grep` on a directory reads the files below it, so a deny rule for one of
 * those files must apply to the directory search too.
 */
export function mayMatchInside(path: string, specifier: string, context: PathContext): boolean {
  const prefix = [...`${foldForMatching(path, context).replace(/\/$/, "")}/`];
  return specifierTokenSets(specifier, context).some((tokens) =>
    reachableAfterEachToken(prefix, tokens).some((step) => step[prefix.length] === 1),
  );
}
