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

// `$cmd`, `{rm,ls}` and `r?` do not name one fixed command.
function isStaticCommandName(name: Word): boolean {
  if (GLOB_CHARACTERS.test(name.value)) return false;
  return (name.parts ?? []).every((part) => {
    if (part.type === "DoubleQuoted") return part.parts.every((child) => child.type === "Literal");
    return part.type === "Literal" || part.type === "SingleQuoted" || part.type === "AnsiCQuoted";
  });
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
    withoutWrappers(unquoted),
    withoutWrappers(unquotedBase),
  ];
  const blockForms = [...new Set(variants.map((words) => collapseWhitespace(words.join(" "))))];
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
