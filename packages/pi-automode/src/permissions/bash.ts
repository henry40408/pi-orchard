import { basename } from "node:path";
import { parse } from "unbash";
import type {
  AndOr,
  ArithmeticExpression,
  Assignment,
  Command,
  CompoundList,
  ParsedScript,
  PipelineNode,
  Redirection,
  TestExpression,
  Word,
  WordPart,
} from "unbash";

/** One simple command, described by the forms that rules are matched against. */
export interface BashUnit {
  /** Forms tested by deny and ask rules: any match counts. */
  blockForms: string[];
  /** Forms tested by allow rules: every form must match. */
  allowForms: string[];
}

export interface BashAnalysis {
  /** Every simple command found, including those nested in substitutions, subshells and loops. */
  units: BashUnit[];
  /**
   * False when the command cannot be fully analysed: a parse error, a dynamic
   * command name, a function definition, or output written to a file. Such a
   * command must never be allowed by a specifier rule.
   */
  complete: boolean;
}

// Real commands never nest this deep; refusing to analyse bounds the recursion.
const MAX_NESTING_DEPTH = 50;
const OUTPUT_FILE_OPERATORS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const DESCRIPTOR_DUPLICATION_OPERATORS = new Set([">&", "<&"]);
const GLOB_CHARACTERS = /[*?[]/;
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
// Their `--` separates their own arguments from the command they run.
const CONTAINER_TOOLS = new Set(["docker", "podman", "kubectl"]);
// Commands that run their arguments as another command: `sudo rm` also is `rm`.
const WRAPPER_COMMANDS = new Set([
  "command",
  "builtin",
  "exec",
  "sudo",
  "doas",
  "env",
  "nohup",
  "nice",
  "time",
  "timeout",
  "xargs",
  "stdbuf",
]);

/**
 * Parses a shell command into the simple commands it runs.
 * Why: a rule like `bash(ls:*)` must not allow `ls && rm -rf /`, and
 * `bash(rm -rf:*)` must still deny `echo $(rm -rf /)`.
 */
export function analyzeBash(command: string): BashAnalysis {
  const units: BashUnit[] = [];
  let complete = true;
  const markIncomplete = () => {
    complete = false;
  };

  function visitScript(script: ParsedScript | undefined, depth: number): void {
    if (!script || script.errors?.length) markIncomplete();
    if (!script) return;
    for (const statement of script.commands) visitNode(statement.command, depth);
  }

  function visitList(list: CompoundList, depth: number): void {
    for (const statement of list.commands) visitNode(statement.command, depth);
  }

  function visitNode(node: PipelineNode | AndOr | CompoundList | undefined, depth: number): void {
    if (!node) return markIncomplete();
    if (depth > MAX_NESTING_DEPTH) return markIncomplete();
    const next = depth + 1;

    switch (node.type) {
      case "Command":
        return visitCommand(node, next);
      case "AndOr":
      case "Pipeline":
        return node.commands.forEach((child) => visitNode(child, next));
      case "Time":
      case "Negation":
        return visitNode(node.command, next);
      case "CompoundList":
        return visitList(node, next);
      case "If":
        visitList(node.clause, next);
        visitList(node.then, next);
        return node.else ? visitNode(node.else, next) : undefined;
      case "For":
      case "Select":
        visitWord(node.name, next);
        node.wordlist?.forEach((word) => visitWord(word, next));
        return visitList(node.body, next);
      case "ArithmeticFor":
        for (const expression of [node.initialize, node.test, node.update]) {
          if (expression) visitArithmetic(expression, next);
        }
        return visitList(node.body, next);
      case "While":
        visitList(node.clause, next);
        return visitList(node.body, next);
      case "Subshell":
      case "BraceGroup":
        return visitList(node.body, next);
      case "Case":
        visitWord(node.word, next);
        for (const item of node.items) {
          item.pattern.forEach((word) => visitWord(word, next));
          visitList(item.body, next);
        }
        return;
      case "TestCommand":
        return visitTest(node.expression, next);
      case "ArithmeticCommand":
        if (!node.expression) return markIncomplete();
        return visitArithmetic(node.expression, next);
      case "Redirected":
        node.redirects.forEach((redirect) => visitRedirect(redirect, next));
        return visitNode(node.command, next);
      case "Function":
        // The body runs later, under a name that may shadow a real command.
        markIncomplete();
        return visitNode(node.body, next);
      case "Coproc":
        return visitNode(node.body, next);
      default:
        return markIncomplete();
    }
  }

  function visitCommand(node: Command, depth: number): void {
    const assignments: Assignment[] = [];
    for (const item of node.prefix) {
      if (item.type === "Assignment") {
        assignments.push(item);
        visitAssignment(item, depth);
      } else {
        visitRedirect(item, depth);
      }
    }
    const args: (Word | Assignment)[] = [];
    for (const item of node.suffix) {
      if (item.type === "Word") {
        args.push(item);
        visitWord(item, depth);
      } else if (item.type === "Assignment") {
        args.push(item);
        visitAssignment(item, depth);
      } else {
        visitRedirect(item, depth);
      }
    }

    if (!node.name) {
      // `PATH=/evil` alone changes later commands, so it needs a rule of its own.
      const text = collapseWhitespace(assignments.map((assignment) => assignment.text).join(" "));
      if (text) units.push({ blockForms: [text], allowForms: [text] });
      return;
    }
    visitWord(node.name, depth);
    if (!isStaticCommandName(node.name)) markIncomplete();
    units.push(describeCommand({ assignments, name: node.name, args }));

    const words = [node.name, ...args];
    const { start, remoteShell } = embeddedCommand(words.map(wordValue));
    const embedded = words.slice(start);
    if (remoteShell) return visitShellWords(embedded, depth);
    visitInterpreter(embedded, depth);
  }

  // The words are joined into one string and run by a shell, as `eval` and `ssh` do.
  function visitShellWords(words: (Word | Assignment)[], depth: number): void {
    // Without a command, ssh opens an interactive shell.
    if (words.length === 0 || !words.every(isLiteralWord)) return markIncomplete();
    visitShellText(words.map(wordValue).join(" "), depth);
  }

  // Commands that run a string as shell code: `bash -c '...'` and `eval ...`.
  function visitInterpreter(words: (Word | Assignment)[], depth: number): void {
    const first = words[0];
    if (!first || first.type !== "Word") return;
    const program = basename(first.value);

    if (program === "eval") {
      if (words.length === 1) return;
      return visitShellWords(words.slice(1), depth);
    }
    if (!SHELL_INTERPRETERS.has(program)) return;

    const script = findShellScript(words);
    // Without -c the shell reads a script file or stdin, which we cannot see.
    if (!script || !isLiteralWord(script)) return markIncomplete();
    visitShellText(script.value, depth);
  }

  function visitShellText(text: string, depth: number): void {
    visitScript(parse(text), depth + 1);
  }

  function visitWord(word: Word, depth: number): void {
    word.parts?.forEach((part) => visitPart(part, depth));
  }

  function visitPart(part: WordPart | NonNullable<Word["parts"]>[number], depth: number): void {
    switch (part.type) {
      case "CommandExpansion":
      case "ProcessSubstitution":
        return visitScript(part.script, depth + 1);
      case "DoubleQuoted":
      case "LocaleString":
        return part.parts.forEach((child) => visitPart(child, depth));
      case "ParameterExpansion":
        if (part.index) visitWord(part.index, depth);
        return visitParameterOperation(part.operation, depth);
      case "ArithmeticExpansion":
        if (!part.expression) return markIncomplete();
        return visitArithmetic(part.expression, depth);
      case "ExtendedGlob":
      case "BraceExpansion":
        return part.parts?.forEach((child) => visitPart(child, depth));
      default:
        return;
    }
  }

  function visitParameterOperation(
    operation: Extract<WordPart, { type: "ParameterExpansion" }>["operation"],
    depth: number,
  ): void {
    if (!operation) return;
    switch (operation.type) {
      case "Default":
      case "Remove":
      case "Transform":
        return visitWord(operation.operand, depth);
      case "Replace":
        visitWord(operation.pattern, depth);
        return visitWord(operation.replacement, depth);
      case "Slice":
        visitWord(operation.offset, depth);
        if (operation.length) visitWord(operation.length, depth);
        return;
      case "CaseModification":
        if (operation.operand) visitWord(operation.operand, depth);
        return;
      case "Names":
        return;
      default:
        return markIncomplete();
    }
  }

  function visitArithmetic(expression: ArithmeticExpression, depth: number): void {
    switch (expression.type) {
      case "ArithmeticBinary":
        visitArithmetic(expression.left, depth);
        return visitArithmetic(expression.right, depth);
      case "ArithmeticUnary":
        return visitArithmetic(expression.operand, depth);
      case "ArithmeticTernary":
        visitArithmetic(expression.test, depth);
        visitArithmetic(expression.consequent, depth);
        return visitArithmetic(expression.alternate, depth);
      case "ArithmeticGroup":
        return visitArithmetic(expression.expression, depth);
      case "ArithmeticWord":
        return expression.parts?.forEach((part) => visitPart(part, depth));
      case "ArithmeticCommandExpansion":
        return visitScript(expression.script, depth + 1);
    }
  }

  function visitTest(expression: TestExpression, depth: number): void {
    switch (expression.type) {
      case "TestUnary":
        return visitWord(expression.operand, depth);
      case "TestBinary":
        visitWord(expression.left, depth);
        return visitWord(expression.right, depth);
      case "TestLogical":
        visitTest(expression.left, depth);
        return visitTest(expression.right, depth);
      case "TestNot":
        return visitTest(expression.operand, depth);
      case "TestGroup":
        return visitTest(expression.expression, depth);
    }
  }

  function visitAssignment(assignment: Assignment, depth: number): void {
    if (assignment.index) visitWord(assignment.index, depth);
    if (assignment.value.type === "ArrayValue") {
      assignment.value.elements.forEach((element) => visitWord(element, depth));
    } else {
      visitWord(assignment.value, depth);
    }
  }

  function visitRedirect(redirect: Redirection, depth: number): void {
    if (redirect.type === "HereDoc") {
      // An unterminated here-document swallows the rest of the script.
      if (!redirect.delimiter || !redirect.closing) markIncomplete();
      redirect.body.parts?.forEach((part) => visitPart(part, depth));
      return;
    }
    if (!redirect.target) return markIncomplete();
    visitWord(redirect.target, depth);
    if (redirect.type === "HereString") return;
    if (!writesToFile(redirect.operator, redirect.target)) return;
    markIncomplete();
  }

  try {
    visitScript(parse(command), 0);
  } catch {
    // Too deeply nested for the parser or the walker.
    return { units, complete: false };
  }
  return { units, complete };
}

// `2>&1` and `> /dev/null` are harmless; `>&file` and `> file` write a file.
function writesToFile(operator: string, target: Word): boolean {
  if (DESCRIPTOR_DUPLICATION_OPERATORS.has(operator)) return !/^(?:\d+|-)$/.test(target.text);
  if (!OUTPUT_FILE_OPERATORS.has(operator)) return false;
  return target.text !== "/dev/null";
}

// True when the word's value is known without running anything: no expansions.
function isLiteralWord(word: Word | Assignment): boolean {
  if (word.type !== "Word") return false;
  return (word.parts ?? []).every((part) => {
    if (part.type === "DoubleQuoted") return part.parts.every((child) => child.type === "Literal");
    return part.type === "Literal" || part.type === "SingleQuoted" || part.type === "AnsiCQuoted";
  });
}

function wordValue(word: Word | Assignment): string {
  return word.type === "Word" ? word.value : word.text;
}

// `$cmd`, `{rm,ls}` and `r?` do not name one fixed command.
function isStaticCommandName(name: Word): boolean {
  return isLiteralWord(name) && !GLOB_CHARACTERS.test(name.value);
}

// Options of a shell that take the next word as their value.
const SHELL_OPTIONS_WITH_VALUE = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);

// The script of `bash [options] -c SCRIPT`, or undefined when there is no -c.
function findShellScript(words: (Word | Assignment)[]): Word | undefined {
  for (let i = 1; i < words.length; i++) {
    const option = wordValue(words[i]!);
    if (!/^[-+]/.test(option) || option === "--") return undefined;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(option)) {
      const script = words[i + 1];
      return script?.type === "Word" ? script : undefined;
    }
    if (SHELL_OPTIONS_WITH_VALUE.has(option)) i++;
  }
  return undefined;
}

interface EmbeddedCommand {
  /** Index in the words where the command that really runs starts. */
  start: number;
  /** True when the words from `start` are joined and parsed by a remote shell (ssh). */
  remoteShell: boolean;
}

interface OptionsWithValue {
  /** Short options that take a value, as a string of letters. */
  letters: string;
  /** Long options that take a value as the next word. */
  long: ReadonlySet<string>;
}

// Options of ssh(1) that take a value.
const SSH_OPTIONS: OptionsWithValue = { letters: "BbcDEeFIiJLlmOoPpQRSWw", long: new Set() };
const DOCKER_GLOBAL_OPTIONS: OptionsWithValue = {
  letters: "Hcl",
  long: new Set(["--host", "--context", "--config", "--log-level", "--tlscacert", "--tlscert", "--tlskey"]),
};
const PODMAN_GLOBAL_OPTIONS: OptionsWithValue = {
  letters: "clu",
  long: new Set([
    "--cgroup-manager", "--conmon", "--connection", "--events-backend", "--hooks-dir", "--identity",
    "--imagestore", "--log-level", "--module", "--network-cmd-path", "--network-config-dir",
    "--registries-conf", "--root", "--runroot", "--runtime", "--runtime-flag", "--storage-driver",
    "--storage-opt", "--tmpdir", "--url", "--volumepath",
  ]),
};
const DOCKER_EXEC_OPTIONS: OptionsWithValue = {
  letters: "euw",
  long: new Set(["--env", "--env-file", "--user", "--workdir", "--detach-keys", "--preserve-fds", "--preserve-fd"]),
};
const COMPOSE_OPTIONS: OptionsWithValue = {
  letters: "fp",
  long: new Set([
    "--file", "--project-name", "--project-directory", "--profile", "--env-file", "--parallel", "--ansi", "--progress",
  ]),
};
const COMPOSE_EXEC_OPTIONS: OptionsWithValue = {
  letters: "euw",
  long: new Set(["--env", "--user", "--workdir", "--index"]),
};

/**
 * Where the command that really runs starts in `words`: after wrappers such as
 * `sudo`, after the host of `ssh`, after the container of `docker exec`, and
 * after the `--` of `kubectl exec POD -- CMD` or `docker run ... -- CMD`.
 */
function embeddedCommand(words: string[]): EmbeddedCommand {
  let start = 0;
  for (;;) {
    const rest = words.slice(start);
    let next = start + (rest.length - withoutWrappers(rest).length);
    const hop = commandAfterHop(words.slice(next));
    if (hop?.remoteShell) return { start: next + hop.start, remoteShell: true };
    if (hop) {
      next += hop.start;
    } else {
      const afterSeparator = afterContainerSeparator(words.slice(next));
      if (afterSeparator !== undefined) next = words.length - afterSeparator.length;
    }
    if (next === start) return { start, remoteShell: false };
    start = next;
  }
}

/** The command that `ssh HOST CMD` or `docker exec CONTAINER CMD` runs, if `words` is one of them. */
function commandAfterHop(words: string[]): EmbeddedCommand | undefined {
  const program = basename(words[0] ?? "");
  if (program === "ssh") {
    const host = skipOptions(words, 1, SSH_OPTIONS);
    if (host >= words.length) return undefined;
    // ssh reads options again after the host: `ssh host -t CMD`.
    return { start: skipOptions(words, host + 1, SSH_OPTIONS), remoteShell: true };
  }

  if (program === "docker-compose") return commandAfterExec(words, 1, COMPOSE_OPTIONS, COMPOSE_EXEC_OPTIONS);

  if (program === "docker" || program === "podman") {
    let subcommand = skipOptions(words, 1, program === "podman" ? PODMAN_GLOBAL_OPTIONS : DOCKER_GLOBAL_OPTIONS);
    if (program === "docker" && words[subcommand] === "compose") {
      return commandAfterExec(words, subcommand + 1, COMPOSE_OPTIONS, COMPOSE_EXEC_OPTIONS);
    }
    if (words[subcommand] === "container") subcommand++;
    return commandAfterExec(words, subcommand, undefined, DOCKER_EXEC_OPTIONS);
  }

  return undefined;
}

/** The command of `exec [OPTIONS] TARGET CMD`, where `words[from]` is the subcommand or the options before it. */
function commandAfterExec(
  words: string[],
  from: number,
  globalOptions: OptionsWithValue | undefined,
  execOptions: OptionsWithValue,
): EmbeddedCommand | undefined {
  const subcommand = globalOptions ? skipOptions(words, from, globalOptions) : from;
  if (words[subcommand] !== "exec") return undefined;
  const target = skipOptions(words, subcommand + 1, execOptions);
  // `podman exec --latest CMD` has no container: the first word is already the command.
  const hasTarget = !words.slice(subcommand + 1, target).some(isLatestOption);
  const command = hasTarget ? target + 1 : target;
  // Words after the target are the command, even when a `--` separates them.
  return { start: Math.min(words[command] === "--" ? command + 1 : command, words.length), remoteShell: false };
}

function isLatestOption(option: string): boolean {
  if (option.startsWith("--")) return option === "--latest";
  if (!option.startsWith("-")) return false;
  // Letters after one that takes a value belong to that value.
  const letters = option.slice(1);
  const valued = letters.search(/[euw]/);
  return (valued === -1 ? letters : letters.slice(0, valued)).includes("l");
}

/** The index of the first word from `from` that is not an option or the value of one. */
function skipOptions(words: string[], from: number, valued: OptionsWithValue): number {
  let i = from;
  while (i < words.length) {
    const word = words[i]!;
    if (word === "--") return i + 1;
    if (!word.startsWith("-") || word === "-") return i;
    i += optionTakesNextWord(word, valued) ? 2 : 1;
  }
  return i;
}

function optionTakesNextWord(option: string, valued: OptionsWithValue): boolean {
  if (option.startsWith("--")) return valued.long.has(option);
  // In `-it` or `-eVAR`, the first letter that takes a value ends the option.
  // The value is the next word only when that letter is the last one.
  for (let i = 1; i < option.length; i++) {
    if (valued.letters.includes(option[i]!)) return i === option.length - 1;
  }
  return false;
}

function afterContainerSeparator(words: string[]): string[] | undefined {
  if (words.length === 0 || !CONTAINER_TOOLS.has(basename(words[0]!))) return undefined;
  const separator = words.indexOf("--");
  return separator === -1 ? undefined : words.slice(separator + 1);
}

interface CommandParts {
  assignments: Assignment[];
  name: Word;
  args: (Word | Assignment)[];
}

function describeCommand({ assignments, name, args }: CommandParts): BashUnit {
  const written = [...assignments.map((a) => a.text), name.text, ...args.map((a) => a.text)];
  const writtenWithoutAssignments = [name.text, ...args.map((a) => a.text)];
  const unquoted = [name.value, ...args.map((a) => (a.type === "Word" ? a.value : a.text))];
  const unquotedBase = [basename(name.value), ...unquoted.slice(1)];

  const variants = [
    written,
    writtenWithoutAssignments,
    unquoted,
    unquotedBase,
    unquoted.slice(embeddedCommand(unquoted).start),
    unquotedBase.slice(embeddedCommand(unquotedBase).start),
  ];
  const blockForms = Array.from(new Set(variants.map((words) => collapseWhitespace(words.join(" ")))));
  return { blockForms, allowForms: [collapseWhitespace(written.join(" "))] };
}

function withoutWrappers(words: string[]): string[] {
  let rest = words;
  while (rest.length > 1 && WRAPPER_COMMANDS.has(basename(rest[0]!))) {
    let next = 1;
    while (next < rest.length && /^(?:-|[A-Za-z_]\w*=|\d)/.test(rest[next]!)) next++;
    rest = rest.slice(next);
  }
  return rest;
}

function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** `cmd` matches exactly; `cmd:*` matches `cmd` and anything starting with `cmd `. */
export function matchesBashSpecifier(form: string, specifier: string): boolean {
  if (!specifier.endsWith(":*")) return form === collapseWhitespace(specifier);
  const prefix = collapseWhitespace(specifier.slice(0, -2));
  return form === prefix || form.startsWith(`${prefix} `);
}
