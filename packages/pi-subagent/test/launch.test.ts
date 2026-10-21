import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PARENT_MODE_ENV } from "../src/guard.ts";
import { buildLaunch, CHILD_ENV } from "../src/launch.ts";

describe("buildLaunch", () => {
  it("loads only automode, from the parent's file, and passes the parent mode", () => {
    const launch = buildLaunch({
      task: "do it",
      guard: { kind: "guarded", entry: "/a/index.ts", mode: "rules" },
      environment: { HOME: "/h" },
    });
    assert.deepEqual(launch.args, ["--mode", "json", "-p", "--no-session", "--no-extensions", "-e", "/a/index.ts", "Task: do it"]);
    assert.deepEqual(launch.environment, { HOME: "/h", [PARENT_MODE_ENV]: "rules", [CHILD_ENV]: "1" });
  });

  it("ignores the requested model under automode, and honours it without", () => {
    const guarded = buildLaunch({
      task: "t",
      guard: { kind: "guarded", entry: "/a", mode: "auto" },
      requestedModel: "weak/model",
      parentModel: "strong/model",
      environment: {},
    });
    assert.deepEqual(guarded.args.slice(guarded.args.indexOf("--model"), guarded.args.indexOf("--model") + 2), ["--model", "strong/model"]);
    const free = buildLaunch({ task: "t", guard: { kind: "none" }, requestedModel: "weak/model", parentModel: "strong/model", environment: {} });
    assert.ok(free.args.includes("weak/model"));
  });

  it("overwrites a parent mode that was already in the environment", () => {
    const launch = buildLaunch({
      task: "t",
      guard: { kind: "guarded", entry: "/a", mode: "ask" },
      environment: { [PARENT_MODE_ENV]: "off" },
    });
    assert.equal(launch.environment[PARENT_MODE_ENV], "ask");
  });

  it("leaves discovery and the environment alone without automode", () => {
    const launch = buildLaunch({ task: "t", guard: { kind: "none" }, environment: { HOME: "/h" } });
    assert.equal(launch.args.includes("--no-extensions"), false);
    assert.deepEqual(launch.environment, { HOME: "/h", [CHILD_ENV]: "1" });
  });

  it("adds model and tools, and keeps a task that starts with a dash from being an option", () => {
    const launch = buildLaunch({
      task: "--help",
      guard: { kind: "none" },
      requestedModel: "p/m",
      tools: ["read", "grep"],
      environment: {},
    });
    assert.deepEqual(launch.args.slice(-5), ["--model", "p/m", "--tools", "read,grep", "Task: --help"]);
  });

  it("does not change the environment it was given", () => {
    const environment = { HOME: "/h" };
    buildLaunch({ task: "t", guard: { kind: "guarded", entry: "/a", mode: "auto" }, environment });
    assert.deepEqual(environment, { HOME: "/h" });
  });

  it("marks every child, so the child cannot start children", () => {
    for (const guard of [{ kind: "none" }, { kind: "guarded", entry: "/a", mode: "auto" }] as const) {
      assert.equal(buildLaunch({ task: "t", guard, environment: {} }).environment[CHILD_ENV], "1");
    }
  });
});
