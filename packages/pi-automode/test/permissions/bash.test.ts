import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bashAllowForms,
  bashBlockForms,
  matchesBashSpecifier,
  splitBashCommand,
} from "../../src/permissions/bash.ts";

describe("splitBashCommand", () => {
  // A command nested in a substitution comes before the command containing it.
  const splits: [string, string, string[]][] = [
    ["a single command", "ls -la", ["ls -la"]],
    ["&&", "ls && pwd", ["ls", "pwd"]],
    ["||", "ls || pwd", ["ls", "pwd"]],
    ["a semicolon", "ls; pwd", ["ls", "pwd"]],
    ["a pipe", "cat a | grep b", ["cat a", "grep b"]],
    ["a background job", "sleep 1 & pwd", ["sleep 1", "pwd"]],
    ["a newline", "ls\npwd", ["ls", "pwd"]],
    ["$(...)", "echo $(rm -rf /)", ["rm -rf /", "echo $(rm -rf /)"]],
    ["backticks", "echo `rm -rf /`", ["rm -rf /", "echo `rm -rf /`"]],
    ["nested substitution", "echo $(echo $(id))", ["id", "echo $(id)", "echo $(echo $(id))"]],
    ["process substitution", "diff <(ls a) <(ls b)", ["ls a", "ls b", "diff <(ls a) <(ls b)"]],
    ["a subshell", "(cd x && rm -rf y)", ["cd x", "rm -rf y"]],
    ["a substitution inside double quotes", 'echo "$(rm -rf /)"', ["rm -rf /", 'echo "$(rm -rf /)"']],
    ["operators inside single quotes", "echo 'a && rm -rf /'", ["echo 'a && rm -rf /'"]],
    ["operators inside double quotes", 'git commit -m "a && b; c"', ['git commit -m "a && b; c"']],
    ["a substitution inside single quotes", "echo '$(rm)'", ["echo '$(rm)'"]],
    ["an escaped operator", "echo a\\;b", ["echo a\\;b"]],
    ["an escaped quote", 'echo "a\\" && b"', ['echo "a\\" && b"']],
  ];
  for (const [name, command, segments] of splits) {
    it(`splits ${name}`, () => {
      const result = splitBashCommand(command);
      assert.deepEqual(result.segments, segments);
      assert.equal(result.complete, true);
    });
  }

  const harmlessRedirects = ["ls 2>&1", "ls >&2", "ls > /dev/null", "ls 2>/dev/null", "ls &>/dev/null"];
  for (const command of harmlessRedirects) {
    it(`treats "${command}" as fully analysed`, () => {
      assert.equal(splitBashCommand(command).complete, true);
    });
  }

  const incomplete = [
    ["output redirected to a file", "echo hi > ~/.bashrc"],
    ["output appended to a file", "echo hi >> out.txt"],
    ["a quoted redirect target", 'echo hi > "/dev/null"'],
    ["an unterminated single quote", "echo 'oops"],
    ["an unterminated double quote", 'echo "oops'],
    ["an unterminated substitution", "echo $(ls"],
    ["an unterminated backtick", "echo `ls"],
    ["a stray closing parenthesis", "ls )"],
  ];
  for (const [name, command] of incomplete) {
    it(`flags ${name} as not fully analysed`, () => {
      assert.equal(splitBashCommand(command).complete, false);
    });
  }

  it("still returns the commands of an incomplete command", () => {
    assert.deepEqual(splitBashCommand("rm -rf x; echo 'oops").segments, ["rm -rf x", "echo 'oops"]);
  });

  it("does not end $'...' at an escaped quote", () => {
    const result = splitBashCommand("echo $'a\\'b' ; touch pwned #'");
    assert.deepEqual(result.segments, ["echo $'a\\'b'", "touch pwned"]);
    assert.equal(result.complete, true);
  });

  it("flags a file descriptor duplication followed by a word as a file write", () => {
    assert.equal(splitBashCommand("echo hi >&2pwned").complete, false);
    assert.equal(splitBashCommand("echo hi >&2; ls").complete, true);
  });

  it("ends a comment at the newline", () => {
    assert.deepEqual(splitBashCommand("ls # it's\nrm -rf x").segments, ["ls", "rm -rf x"]);
  });

  it("does not treat a # inside a word as a comment", () => {
    assert.deepEqual(splitBashCommand("echo a#b; rm x").segments, ["echo a#b", "rm x"]);
  });

  it("does not start a comment after an escaped blank or a line continuation", () => {
    for (const command of ["echo a\\ #; touch pwned", "echo a\\\t#; touch pwned", "echo a\\\n#; touch pwned"]) {
      assert.ok(splitBashCommand(command).segments.includes("touch pwned"), command);
    }
  });

  it("does not let ${...} hide a # or quote", () => {
    for (const command of ["echo ${x:- #}; touch pwned", `echo "\${x:-'"'}"; touch pwned #'`]) {
      const result = splitBashCommand(command);
      assert.equal(result.complete, false, command);
      assert.ok(result.segments.includes("touch pwned") || result.segments.some((s) => s.includes("touch pwned")));
    }
  });

  it("does not read $$' as ANSI-C quoting", () => {
    const result = splitBashCommand("echo $$'\\'; touch pwned #'");
    assert.ok(result.segments.includes("touch pwned"));
  });

  it("flags backticks nested as \\` as not fully analysed", () => {
    assert.equal(splitBashCommand("echo `echo \\`touch pwned\\``").complete, false);
  });

  it("flags here-documents as not fully analysed but allows here-strings", () => {
    assert.equal(splitBashCommand("cat <<EOF\nhi\nEOF").complete, false);
    assert.equal(splitBashCommand("cat <<'EOF'\nit's\nEOF").complete, false);
    assert.equal(splitBashCommand("cat <<< hello").complete, true);
  });

  it("flags case patterns as not fully analysed", () => {
    assert.equal(splitBashCommand("echo $(case a in a) touch pwned;; esac)").complete, false);
  });

  it("refuses to analyse deeply nested commands without throwing", () => {
    const result = splitBashCommand("$(".repeat(100_000));
    assert.equal(result.complete, false);
  });

  it("returns no segments for an empty command", () => {
    assert.deepEqual(splitBashCommand("  "), { segments: [], complete: true });
  });
});

describe("bash forms", () => {
  it("collapses whitespace", () => {
    assert.deepEqual(bashAllowForms("  rm   -rf \t x "), ["rm -rf x"]);
  });

  it("adds a form without leading assignments for deny and ask", () => {
    const forms = bashBlockForms("FOO=1 BAR='a b' rm -rf x");
    assert.deepEqual(forms.slice(0, 2), ["FOO=1 BAR='a b' rm -rf x", "rm -rf x"]);
  });

  it("adds a form without leading shell keywords for deny and ask", () => {
    assert.deepEqual(bashBlockForms("then rm -rf x"), ["then rm -rf x", "rm -rf x"]);
    assert.deepEqual(bashBlockForms("{ ! time rm x"), ["{ ! time rm x", "rm x"]);
  });

  it("strips leading redirects", () => {
    assert.deepEqual(bashBlockForms(">/dev/null rm -rf x"), [">/dev/null rm -rf x", "rm -rf x"]);
    assert.deepEqual(bashBlockForms("2> /dev/null rm x"), ["2> /dev/null rm x", "rm x"]);
  });

  it("strips assignments whose value is escaped or contains quotes", () => {
    assert.equal(bashBlockForms("FOO=a\\ b rm -rf x")[1], "rm -rf x");
    assert.equal(bashBlockForms('FOO=a"b c" rm -rf x')[1], "rm -rf x");
    assert.equal(bashBlockForms("FOO='a b'c rm -rf x")[1], "rm -rf x");
  });

  it("strips append, subscript and substitution assignments and function definitions", () => {
    for (const segment of [
      "FOO+=1 touch pwned",
      "FOO=$(echo a) touch pwned",
      "a[0]=1 touch pwned",
      "function f { touch pwned",
    ]) {
      assert.ok(bashBlockForms(segment).includes("touch pwned"), segment);
    }
  });

  it("adds a form with quotes, backslashes and line continuations removed", () => {
    for (const segment of ["'touch' pwned", "\\touch pwned", "tou\\\nch pwned"]) {
      assert.ok(bashBlockForms(segment).includes("touch pwned"), segment);
    }
  });

  it("does not strip assignments for allow rules", () => {
    assert.deepEqual(bashAllowForms("PATH=/evil ls"), ["PATH=/evil ls"]);
  });
});

describe("matchesBashSpecifier", () => {
  it("matches an exact command", () => {
    assert.equal(matchesBashSpecifier("git status", "git status"), true);
    assert.equal(matchesBashSpecifier("git status -s", "git status"), false);
  });

  it("matches a prefix on a word boundary", () => {
    assert.equal(matchesBashSpecifier("git diff", "git diff:*"), true);
    assert.equal(matchesBashSpecifier("git diff --cached", "git diff:*"), true);
    assert.equal(matchesBashSpecifier("git diffstat", "git diff:*"), false);
    assert.equal(matchesBashSpecifier("ls", "ls:*"), true);
    assert.equal(matchesBashSpecifier("lsof", "ls:*"), false);
  });

  it("ignores repeated spaces in the specifier", () => {
    assert.equal(matchesBashSpecifier("rm -rf x", "rm  -rf:*"), true);
  });

  it("treats other asterisks literally", () => {
    assert.equal(matchesBashSpecifier("ls anything", "ls *"), false);
    assert.equal(matchesBashSpecifier("ls *", "ls *"), true);
  });
});
