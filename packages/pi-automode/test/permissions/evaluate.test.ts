import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { evaluatePermissions, type Permissions } from "../../src/permissions/evaluate.ts";
import type { PathContext } from "../../src/permissions/paths.ts";

let root: string;
let pathContext: PathContext;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-automode-")));
  mkdirSync(join(root, "project"));
  mkdirSync(join(root, "home"));
  pathContext = { cwd: join(root, "project"), home: join(root, "home"), caseInsensitive: false };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function evaluate(permissions: Partial<Permissions>, toolName: string, input: unknown) {
  return evaluatePermissions({
    permissions: { allow: [], ask: [], deny: [], ...permissions },
    toolName,
    input,
    pathContext,
  });
}

const bash = (command: string) => ({ command });

describe("priority", () => {
  const all: Permissions = { allow: ["bash(ls:*)"], ask: ["bash(ls:*)"], deny: ["bash(ls:*)"] };

  it("prefers deny over ask and allow", () => {
    assert.deepEqual(evaluate(all, "bash", bash("ls")), { decision: "deny", rule: "bash(ls:*)" });
  });

  it("prefers ask over allow", () => {
    assert.equal(evaluate({ ...all, deny: [] }, "bash", bash("ls")).decision, "ask");
  });

  it("does not depend on the order of the rules", () => {
    const rules = ["bash", "bash(ls:*)", "bash(rm:*)"];
    for (const order of [rules, [...rules].reverse()]) {
      const result = evaluate({ allow: order, deny: ["bash(rm:*)"] }, "bash", bash("rm x"));
      assert.equal(result.decision, "deny");
    }
  });

  it("lets a deny rule beat a whole-tool allow", () => {
    const result = evaluate({ allow: ["bash"], deny: ["bash(sudo:*)"] }, "bash", bash("sudo ls"));
    assert.equal(result.decision, "deny");
  });

  it("lets a more specific ask rule not downgrade a deny", () => {
    const result = evaluate(
      { deny: ["read(./.env*)"], ask: ["read(./.env.example)"] },
      "read",
      { path: ".env.example" },
    );
    assert.equal(result.decision, "deny");
  });
});

describe("whole-tool rules", () => {
  it("allow a tool entirely", () => {
    assert.deepEqual(evaluate({ allow: ["read"] }, "read", { path: "a" }), {
      decision: "allow",
      rule: "read",
    });
  });

  it("deny a tool entirely", () => {
    assert.equal(evaluate({ deny: ["write"] }, "write", { path: "a", content: "" }).decision, "deny");
  });

  it("ignore rules for other tools", () => {
    assert.equal(evaluate({ deny: ["write"] }, "read", { path: "a" }).decision, "none");
  });

  it("apply to tools without a specifier syntax", () => {
    assert.equal(evaluate({ allow: ["my-tool"] }, "my-tool", {}).decision, "allow");
  });

  it("allow even a command that cannot be analysed", () => {
    assert.equal(evaluate({ allow: ["bash"] }, "bash", bash("echo 'oops")).decision, "allow");
  });
});

describe("bash", () => {
  const allow = { allow: ["bash(ls:*)", "bash(git status)"] };

  it("allows a command covered by a rule", () => {
    assert.deepEqual(evaluate(allow, "bash", bash("ls -la")), {
      decision: "allow",
      rule: "bash(ls:*)",
    });
  });

  it("returns none when no rule matches", () => {
    assert.equal(evaluate(allow, "bash", bash("pwd")).decision, "none");
  });

  it("allows a compound command only when every part is allowed", () => {
    assert.equal(evaluate(allow, "bash", bash("ls && git status")).decision, "allow");
    assert.equal(evaluate(allow, "bash", bash("ls && rm -rf /")).decision, "none");
    assert.equal(evaluate(allow, "bash", bash("rm -rf / ; ls")).decision, "none");
    assert.equal(evaluate(allow, "bash", bash("ls | sh")).decision, "none");
  });

  it("does not allow what hides inside a substitution", () => {
    assert.equal(evaluate(allow, "bash", bash("ls $(rm -rf /)")).decision, "none");
    assert.equal(evaluate(allow, "bash", bash("ls `rm -rf /`")).decision, "none");
    assert.equal(evaluate(allow, "bash", bash('ls "$(rm -rf /)"')).decision, "none");
  });

  it("denies when any part is denied", () => {
    const rules = { allow: ["bash"], deny: ["bash(rm -rf:*)"] };
    for (const command of [
      "ls && rm -rf /",
      "echo $(rm -rf /)",
      "echo `rm -rf /`",
      "(cd x; rm -rf y)",
      "rm   -rf /",
      "FOO=1 rm -rf /",
      "if true; then rm -rf /; fi",
      "{ rm -rf /; }",
      "! rm -rf /",
    ]) {
      assert.equal(evaluate(rules, "bash", bash(command)).decision, "deny", command);
    }
  });

  it("asks when any part needs asking", () => {
    const rules = { allow: ["bash"], ask: ["bash(git push:*)"] };
    assert.equal(evaluate(rules, "bash", bash("ls && git push origin main")).decision, "ask");
  });

  it("does not let an assignment prefix turn a command into an allowed one", () => {
    assert.equal(evaluate(allow, "bash", bash("PATH=/evil ls")).decision, "none");
  });

  it("does not allow output redirected to a file", () => {
    assert.equal(evaluate(allow, "bash", bash("ls > ~/.bashrc")).decision, "none");
  });

  it("allows a harmless redirect", () => {
    assert.equal(evaluate(allow, "bash", bash("ls 2>&1")).decision, "allow");
    assert.equal(evaluate(allow, "bash", bash("ls 2>/dev/null")).decision, "allow");
  });

  it("does not allow a command that cannot be analysed", () => {
    assert.equal(evaluate(allow, "bash", bash("ls 'oops")).decision, "none");
  });

  it("still denies a command that cannot be analysed", () => {
    assert.equal(evaluate({ deny: ["bash(rm:*)"] }, "bash", bash("rm x 'oops")).decision, "deny");
  });

  it("returns none for an empty command and a missing command", () => {
    assert.equal(evaluate(allow, "bash", bash("")).decision, "none");
    assert.equal(evaluate(allow, "bash", {}).decision, "none");
    assert.equal(evaluate(allow, "bash", { command: 1 }).decision, "none");
    assert.equal(evaluate(allow, "bash", null).decision, "none");
  });
});

describe("path tools", () => {
  const deny = { deny: ["read(./.env*)", "write(./.env*)", "edit(./.env*)"] };

  it("denies a path that matches", () => {
    assert.equal(evaluate(deny, "read", { path: ".env" }).decision, "deny");
    assert.equal(evaluate(deny, "write", { path: ".env.local", content: "" }).decision, "deny");
    assert.equal(evaluate(deny, "edit", { path: ".env", edits: [] }).decision, "deny");
  });

  it("denies every spelling pi resolves to the same file", () => {
    for (const path of [
      "./.env",
      "src/../.env",
      "@.env",
      `${pathContext.cwd}/.env`,
      `file://${pathContext.cwd}/.env`,
    ]) {
      assert.equal(evaluate(deny, "read", { path }).decision, "deny", path);
    }
  });

  it("denies a symlink that points at a denied file", () => {
    writeFileSync(join(pathContext.cwd, ".env"), "secret");
    symlinkSync(join(pathContext.cwd, ".env"), join(pathContext.cwd, "innocent"));
    assert.equal(evaluate(deny, "read", { path: "innocent" }).decision, "deny");
  });

  it("does not apply a rule for one tool to another", () => {
    assert.equal(evaluate({ deny: ["write(./.env*)"] }, "read", { path: ".env" }).decision, "none");
  });

  it("allows a path inside an allowed directory", () => {
    const allow = { allow: ["read(./src/**)"] };
    assert.equal(evaluate(allow, "read", { path: "src/a/b.ts" }).decision, "allow");
    assert.equal(evaluate(allow, "read", { path: "other.ts" }).decision, "none");
  });

  it("does not allow a path that escapes the allowed directory", () => {
    const allow = { allow: ["read(./src/**)"] };
    assert.equal(evaluate(allow, "read", { path: "src/../.env" }).decision, "none");
  });

  it("does not allow a symlink that leaves the allowed directory", () => {
    mkdirSync(join(pathContext.cwd, "src"));
    writeFileSync(join(pathContext.home, "secret"), "x");
    symlinkSync(join(pathContext.home, "secret"), join(pathContext.cwd, "src", "link"));
    assert.equal(evaluate({ allow: ["read(./src/**)"] }, "read", { path: "src/link" }).decision, "none");
  });

  it("uses the working directory when ls, find or grep get no path", () => {
    assert.equal(evaluate({ deny: ["ls(.)"] }, "ls", {}).decision, "deny");
    assert.equal(evaluate({ allow: ["grep(.)"] }, "grep", { pattern: "x" }).decision, "allow");
  });

  it("applies a deny rule for a file to a directory search that reaches it", () => {
    const rules = { deny: ["grep(./.env)"] };
    assert.equal(evaluate(rules, "grep", { pattern: "x", path: "." }).decision, "deny");
    assert.equal(evaluate(rules, "grep", { pattern: "x" }).decision, "deny");
    assert.equal(evaluate(rules, "grep", { pattern: "x", path: "src" }).decision, "none");
    assert.equal(evaluate({ deny: ["ls(./**)"] }, "ls", { path: "." }).decision, "deny");
  });

  it("does not let a directory search be allowed by a rule for a file inside it", () => {
    assert.equal(evaluate({ allow: ["grep(./src/a.ts)"] }, "grep", { path: "." }).decision, "none");
  });

  it("denies a read spelled with a Unicode fallback of a denied name", () => {
    const rules = { deny: ["read(./d’ecran)"] };
    assert.equal(evaluate(rules, "read", { path: "d'ecran" }).decision, "deny");
  });

  it("matches the real path when the working directory is a symlink", () => {
    const link = join(root, "link");
    symlinkSync(pathContext.cwd, link);
    pathContext = { ...pathContext, cwd: link };
    writeFileSync(join(pathContext.cwd, ".env"), "secret");
    assert.equal(evaluate({ deny: ["read(./.env)"] }, "read", { path: ".env" }).decision, "deny");
    assert.equal(evaluate({ allow: ["read(./**)"] }, "read", { path: ".env" }).decision, "allow");
  });

  it("returns none when the path is not a string", () => {
    assert.equal(evaluate({ allow: ["read(./**)"] }, "read", { path: 1 }).decision, "none");
  });
});

describe("hostile input", () => {
  it("matches rules written with a capitalised tool name", () => {
    assert.equal(evaluate({ deny: ["Read(./.env)"] }, "read", { path: ".env" }).decision, "deny");
    assert.equal(evaluate({ deny: ["Bash(rm:*)"] }, "bash", bash("rm x")).decision, "deny");
  });

  it("does not allow a command hidden behind a comment, $'..' or a leading redirect", () => {
    const rules = { allow: ["bash(echo:*)", "bash(ls:*)"], deny: ["bash(rm:*)"] };
    assert.equal(evaluate(rules, "bash", bash("ls # '\nrm -rf x")).decision, "deny");
    assert.equal(evaluate(rules, "bash", bash("echo $'a\\'b' ; touch pwned #'")).decision, "none");
    assert.equal(evaluate(rules, "bash", bash(">/dev/null rm -rf x")).decision, "deny");
    assert.equal(evaluate(rules, "bash", bash("echo hi >&2pwned")).decision, "none");
  });

  it("denies a command run through bash -c, eval or a container", () => {
    const rules = { allow: ["bash"], deny: ["bash(touch:*)"] };
    for (const command of [
      "bash -c 'touch x'",
      "sudo sh -lc \"ls; touch x\"",
      "eval touch x",
      "kubectl exec pod -- touch x",
      "docker exec c -- sh -c 'touch x'",
      "docker exec -it -e A=1 c touch x",
      "podman exec c sh -c 'touch x'",
      "ssh host 'ls; touch x'",
      "ssh -p 22 user@host touch x",
    ]) {
      assert.equal(evaluate(rules, "bash", bash(command)).decision, "deny", command);
    }
  });

  it("does not allow bash -c just because the inner command is allowed", () => {
    const rules = { allow: ["bash(ls:*)"] };
    assert.equal(evaluate(rules, "bash", bash("bash -c 'ls'")).decision, "none");
    assert.equal(evaluate({ allow: ["bash(ls:*)", "bash(bash:*)"] }, "bash", bash("bash -c 'ls'")).decision, "allow");
    assert.equal(evaluate({ allow: ["bash(bash:*)"] }, "bash", bash('bash -c "$X"')).decision, "none");
  });

  it("never allows a deeply nested command", () => {
    const result = evaluate({ allow: ["bash(echo:*)"] }, "bash", bash("echo $(".repeat(100_000)));
    assert.notEqual(result.decision, "allow");
  });
});

describe("specifiers on other tools", () => {
  it("never match", () => {
    assert.equal(evaluate({ deny: ["my-tool(x)"] }, "my-tool", { x: 1 }).decision, "none");
    assert.equal(evaluate({ allow: ["my-tool(x)"] }, "my-tool", { x: 1 }).decision, "none");
  });
});
