import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { matchesPathSpecifier, mayMatchInside, type PathContext, pathForms, symlinkTarget } from "../../src/permissions/paths.ts";

let root: string;
let context: PathContext;

beforeEach(() => {
  // realpath: on macOS the temp dir is itself a symlink.
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-automode-")));
  mkdirSync(join(root, "project"));
  mkdirSync(join(root, "home"));
  context = { cwd: join(root, "project"), home: join(root, "home"), caseInsensitive: false };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pathForms", () => {
  it("resolves relative paths against the working directory", () => {
    assert.deepEqual(pathForms("src/a.ts", context), [join(context.cwd, "src/a.ts")]);
  });

  it("collapses .. segments", () => {
    assert.deepEqual(pathForms("src/../.env", context), [join(context.cwd, ".env")]);
    assert.deepEqual(pathForms("../home/.env", context), [join(context.home, ".env")]);
  });

  it("expands ~ like pi", () => {
    assert.deepEqual(pathForms("~/.ssh/id_rsa", context), [join(context.home, ".ssh/id_rsa")]);
    assert.deepEqual(pathForms("~", context), [context.home]);
  });

  it("strips a leading @ like pi", () => {
    assert.deepEqual(pathForms("@.env", context), [join(context.cwd, ".env")]);
  });

  it("converts Unicode spaces like pi", () => {
    assert.deepEqual(pathForms("my file", context), [join(context.cwd, "my file")]);
  });

  it("converts file:// URLs like pi", () => {
    assert.deepEqual(pathForms(`file://${join(context.cwd, ".env")}`, context), [
      join(context.cwd, ".env"),
    ]);
  });

  it("does not follow a symlink inside the path", () => {
    writeFileSync(join(context.home, ".env"), "secret");
    symlinkSync(join(context.home, ".env"), join(context.cwd, "link"));
    assert.deepEqual(pathForms("link", context), [join(context.cwd, "link")]);
  });
});

describe("symlinkTarget", () => {
  it("returns undefined for a path without symlinks", () => {
    writeFileSync(join(context.cwd, "a.txt"), "x");
    assert.equal(symlinkTarget(join(context.cwd, "a.txt"), context), undefined);
    assert.equal(symlinkTarget(join(context.cwd, "missing/new.txt"), context), undefined);
  });

  it("returns the real path of a symlinked file", () => {
    writeFileSync(join(context.home, ".env"), "secret");
    symlinkSync(join(context.home, ".env"), join(context.cwd, "link"));
    assert.equal(symlinkTarget(join(context.cwd, "link"), context), join(context.home, ".env"));
  });

  it("returns the real path for a file that does not exist yet in a symlinked directory", () => {
    symlinkSync(context.home, join(context.cwd, "dir"));
    assert.equal(symlinkTarget(join(context.cwd, "dir/new.txt"), context), join(context.home, "new.txt"));
  });

  it("follows a symlink whose target does not exist", () => {
    symlinkSync(join(context.home, "created-later"), join(context.cwd, "dangling"));
    assert.equal(symlinkTarget(join(context.cwd, "dangling"), context), join(context.home, "created-later"));
  });

  it("follows a chain of symlinks to the final path", () => {
    writeFileSync(join(context.home, "target"), "x");
    symlinkSync(join(context.home, "target"), join(context.cwd, "second"));
    symlinkSync(join(context.cwd, "second"), join(context.cwd, "first"));
    assert.equal(symlinkTarget(join(context.cwd, "first"), context), join(context.home, "target"));
  });

  it("does not throw on a symlink loop", () => {
    symlinkSync(join(context.cwd, "b"), join(context.cwd, "a"));
    symlinkSync(join(context.cwd, "a"), join(context.cwd, "b"));
    assert.doesNotThrow(() => symlinkTarget(join(context.cwd, "a"), context));
  });

  it("does not report a symlinked working directory", () => {
    const link = join(root, "link");
    symlinkSync(context.cwd, link);
    const linked = { ...context, cwd: link };
    writeFileSync(join(context.cwd, "a.txt"), "x");
    assert.equal(symlinkTarget(join(link, "a.txt"), linked), undefined);
  });
});

describe("matchesPathSpecifier", () => {
  const matches = (path: string, specifier: string, ctx = context) =>
    matchesPathSpecifier(join(ctx.cwd, path), specifier, ctx);

  it("treats ./ and bare patterns as relative to the working directory", () => {
    assert.equal(matches(".env", "./.env"), true);
    assert.equal(matches(".env", ".env"), true);
    assert.equal(matches("a/.env", "./.env"), false);
  });

  it("treats ~/ as relative to the home directory", () => {
    assert.equal(matchesPathSpecifier(join(context.home, ".ssh/id_rsa"), "~/.ssh/**", context), true);
    assert.equal(matchesPathSpecifier(join(context.cwd, ".ssh/id_rsa"), "~/.ssh/**", context), false);
  });

  it("accepts absolute patterns", () => {
    assert.equal(matchesPathSpecifier("/etc/passwd", "/etc/*", context), true);
    assert.equal(matchesPathSpecifier("/etc/ssh/sshd_config", "/etc/*", context), true);
  });

  it("matches * within one segment and a directory covers its contents", () => {
    assert.equal(matches(".env.local", "./.env*"), true);
    assert.equal(matches(".env.d/x/y", "./.env*"), true);
    assert.equal(matches("src/a.ts", "./*.ts"), false);
    assert.equal(matches("a.ts", "./*.ts"), true);
  });

  it("matches ** across directories", () => {
    assert.equal(matches("a/b/c/.env", "./**/.env"), true);
    assert.equal(matches(".env", "./**/.env"), true);
    assert.equal(matches("a/b/c.ts", "./a/**"), true);
    assert.equal(matches("a/b/c.ts", "./a/**.ts"), true);
  });

  it("matches ? as a single character", () => {
    assert.equal(matches("a1", "./a?"), true);
    assert.equal(matches("a12", "./a?"), false);
  });

  it("does not match a sibling that only shares a prefix", () => {
    assert.equal(matches("srcs/a.ts", "./src"), false);
    assert.equal(matches("src/a.ts", "./src"), true);
  });

  it("escapes regular expression characters in the pattern", () => {
    assert.equal(matches("a.b", "./a.b"), true);
    assert.equal(matches("axb", "./a.b"), false);
    assert.equal(matches("(x)", "./(x)"), true);
  });

  it("is case sensitive when the file system is", () => {
    assert.equal(matches(".ENV", "./.env"), false);
  });

  it("ignores case when the file system does", () => {
    const insensitive = { ...context, caseInsensitive: true };
    assert.equal(matches(".ENV", "./.env", insensitive), true);
  });

  it("treats NFC and NFD spellings as the same name when the file system ignores case", () => {
    const insensitive = { ...context, caseInsensitive: true };
    assert.equal(matches("café.txt", "./café.txt", insensitive), true);
    assert.equal(matches("café.txt", "./café.txt"), false);
  });

  it("treats glob characters in the working directory literally", () => {
    const starred = { ...context, cwd: join(context.cwd, "a*b") };
    assert.equal(matchesPathSpecifier(join(starred.cwd, ".env"), "./.env", starred), true);
    assert.equal(matchesPathSpecifier(join(context.cwd, "aXb/.env"), "./.env", starred), false);
  });

  it("matches a specifier against the real path of a symlinked working directory", () => {
    const link = join(root, "link");
    symlinkSync(context.cwd, link);
    const linked = { ...context, cwd: link };
    assert.equal(matchesPathSpecifier(join(context.cwd, ".env"), "./.env", linked), true);
    assert.equal(matchesPathSpecifier(join(link, ".env"), "./.env", linked), true);
  });

  it("matches paths that contain astral characters", () => {
    const emoji = { ...context, cwd: join(context.cwd, "proj😀") };
    assert.equal(matchesPathSpecifier(join(emoji.cwd, ".env"), "./.env", emoji), true);
    assert.equal(mayMatchInside(emoji.cwd, "./.env", emoji), true);
    assert.equal(matches("😀.env", "./?.env"), true);
  });

  it("finishes quickly on a pattern that backtracks badly", () => {
    const started = Date.now();
    assert.equal(matches(`${"a".repeat(8000)}`, "./*a*a*a*a*b"), false);
    assert.ok(Date.now() - started < 2000);
  });
});

describe("mayMatchInside", () => {
  const inside = (dir: string, specifier: string) =>
    mayMatchInside(join(context.cwd, dir), specifier, context);

  it("is true when the glob can match something below the directory", () => {
    assert.equal(inside(".", "./.env"), true);
    assert.equal(inside(".", "./**"), true);
    assert.equal(inside("src", "./src/**/*.key"), true);
  });

  it("is false for an unrelated directory", () => {
    assert.equal(inside("docs", "./src/**"), false);
    assert.equal(inside("src", "./.env"), false);
    assert.equal(inside("src", "./src"), false);
  });
});

describe("pathForms with read fallbacks", () => {
  it("adds the spellings pi tries when the file does not exist", () => {
    const withAmPm = pathForms("Screenshot 10.30 AM.png", context, { readFallbacks: true });
    assert.ok(withAmPm.includes(join(context.cwd, "Screenshot 10.30 AM.png")));
    const curly = pathForms("d'ecran", context, { readFallbacks: true });
    assert.ok(curly.includes(join(context.cwd, "d’ecran")));
  });
});
