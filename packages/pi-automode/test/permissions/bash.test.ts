import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeBash, matchesBashSpecifier } from "../../src/permissions/bash.ts";

// The command each unit runs, as written.
const written = (command: string) => analyzeBash(command).units.map((unit) => unit.allowForms[0]);
const blockForms = (command: string) => analyzeBash(command).units.flatMap((unit) => unit.blockForms);

describe("analyzeBash", () => {
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
    ["a substitution inside ${...}", "echo ${x:-$(id)}", ["id", "echo ${x:-$(id)}"]],
    ["a substitution inside arithmetic", "echo $(( $(id) + 1 ))", ["id", "echo $(( $(id) + 1 ))"]],
    ["operators inside single quotes", "echo 'a && rm -rf /'", ["echo 'a && rm -rf /'"]],
    ["operators inside double quotes", 'git commit -m "a && b; c"', ['git commit -m "a && b; c"']],
    ["a substitution inside single quotes", "echo '$(rm)'", ["echo '$(rm)'"]],
    ["an escaped operator", "echo a\\;b", ["echo a\\;b"]],
    ["an if", "if true; then rm -rf /; fi", ["true", "rm -rf /"]],
    ["a loop", "for f in $(ls); do rm $f; done", ["ls", "rm $f"]],
    ["a brace group", "{ rm -rf /; }", ["rm -rf /"]],
    ["a negation", "! rm -rf /", ["rm -rf /"]],
    ["a case", "case $x in a) rm -rf /;; esac", ["rm -rf /"]],
    ["a leading assignment", "FOO=1 ls", ["FOO=1 ls"]],
    ["an assignment on its own", "FOO=1", ["FOO=1"]],
  ];
  for (const [name, command, expected] of splits) {
    it(`finds the commands of ${name}`, () => {
      const result = analyzeBash(command);
      assert.deepEqual(written(command), expected);
      assert.equal(result.complete, true);
    });
  }

  it("keeps a redirect out of the command text", () => {
    assert.deepEqual(written("ls 2>&1"), ["ls"]);
  });

  const harmlessRedirects = ["ls 2>&1", "ls >&2", "ls >&-", "ls > /dev/null", "ls 2>/dev/null", "ls &>/dev/null", "ls < in.txt"];
  for (const command of harmlessRedirects) {
    it(`treats "${command}" as fully analysed`, () => {
      assert.equal(analyzeBash(command).complete, true);
    });
  }

  const incomplete = [
    ["output redirected to a file", "echo hi > ~/.bashrc"],
    ["output appended to a file", "echo hi >> out.txt"],
    ["a quoted redirect target", 'echo hi > "/dev/null"'],
    ["a file descriptor duplication that names a file", "echo hi >&2pwned"],
    ["an unterminated single quote", "echo 'oops"],
    ["an unterminated double quote", 'echo "oops'],
    ["an unterminated substitution", "echo $(ls"],
    ["an unterminated backtick", "echo `ls"],
    ["a stray closing parenthesis", "ls )"],
    ["a command named by a variable", "$CMD x"],
    ["a command named by a substitution", "$(echo rm) x"],
    ["a command named by a brace expansion", "{rm,ls} x"],
    ["a command named by a glob", "r? x"],
    ["a function definition", "ls() { rm -rf x; }"],
    ["an unterminated here-document", "cat <<EOF\nhi"],
  ];
  for (const [name, command] of incomplete) {
    it(`flags ${name} as not fully analysed`, () => {
      assert.equal(analyzeBash(command).complete, false);
    });
  }

  it("still returns the commands of an incomplete command", () => {
    assert.deepEqual(written("rm -rf x; echo 'oops"), ["rm -rf x", "echo 'oops"]);
  });

  it("returns no units for an empty command", () => {
    assert.deepEqual(analyzeBash("  "), { units: [], complete: true });
  });

  it("refuses to analyse deeply nested commands without throwing", () => {
    assert.equal(analyzeBash("$(".repeat(100_000)).complete, false);
    assert.equal(analyzeBash(`${"( ".repeat(1000)}ls${" )".repeat(1000)}`).complete, false);
    assert.equal(analyzeBash(`${"( ".repeat(60)}ls${" )".repeat(60)}`).complete, false);
  });

  describe("constructs that used to hide a command", () => {
    const hidden: [string, string][] = [
      ["$'...' with an escaped quote", "echo $'a\\'b' ; touch pwned #'"],
      ["a comment that contains a quote", "ls # it's\ntouch pwned"],
      ["an escaped blank before #", "echo a\\ #; touch pwned"],
      ["a line continuation before #", "echo a\\\n#; touch pwned"],
      ["$$ before a quote", "echo $$'\\'; touch pwned #'"],
      ["# inside ${...}", "echo ${x:- #}; touch pwned"],
      ["a quote inside \"${...}\"", `echo "\${x:-'"'}"; touch pwned #'`],
      ["a here-document with a quote", "cat <<EOF\nit's\nEOF\ntouch pwned # '"],
      ["a here-document in a substitution", "echo \"$(cat <<'EOF'\nit's\nEOF\n)\"; touch pwned #'"],
      ["a case pattern in a substitution", "echo $(case a in a) touch pwned;; esac)"],
      ["nested escaped backticks", "echo `echo \\`touch pwned\\``"],
    ];
    for (const [name, command] of hidden) {
      it(`finds the command behind ${name}`, () => {
        assert.ok(written(command).includes("touch pwned"), command);
      });
    }
  });
});

describe("block forms", () => {
  it("keeps the command as written", () => {
    assert.ok(blockForms("rm   -rf \t x").includes("rm -rf x"));
  });

  it("adds a form without leading assignments", () => {
    assert.deepEqual(blockForms("FOO=1 BAR='a b' rm -rf x").slice(0, 2), [
      "FOO=1 BAR='a b' rm -rf x",
      "rm -rf x",
    ]);
  });

  it("finds the command after assignments in any spelling", () => {
    for (const command of [
      "FOO+=1 touch pwned",
      "FOO=$(echo a) touch pwned",
      "a[0]=1 touch pwned",
      "FOO=a\\ b touch pwned",
      'FOO=a"b c" touch pwned',
      "FOO='a b'c touch pwned",
    ]) {
      assert.ok(blockForms(command).includes("touch pwned"), command);
    }
  });

  it("finds the command after a redirect", () => {
    assert.ok(blockForms(">/dev/null touch pwned").includes("touch pwned"));
    assert.ok(blockForms("2> /dev/null touch pwned").includes("touch pwned"));
  });

  it("removes quotes, backslashes and line continuations", () => {
    for (const command of ["'touch' pwned", '"touch" pwned', "\\touch pwned", "tou\\\nch pwned"]) {
      assert.ok(blockForms(command).includes("touch pwned"), command);
    }
  });

  it("adds a form with the directory of the command removed", () => {
    assert.ok(blockForms("/bin/touch pwned").includes("touch pwned"));
  });

  it("adds a form without wrapper commands", () => {
    for (const command of [
      "sudo touch pwned",
      "command touch pwned",
      "env FOO=1 touch pwned",
      "nice -n 5 touch pwned",
      "timeout 5 touch pwned",
      "sudo -E env touch pwned",
    ]) {
      assert.ok(blockForms(command).includes("touch pwned"), command);
    }
  });

  it("does not add the assignment-free form to the allow forms", () => {
    assert.deepEqual(analyzeBash("PATH=/evil ls").units[0]!.allowForms, ["PATH=/evil ls"]);
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
