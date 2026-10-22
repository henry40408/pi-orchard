import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLASSIFIER_MODEL_ENV, LOG_ENABLED_ENV, PARENT_MODE_ENV } from "../src/guard.ts";
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

  it("works on the requested model with or without automode", () => {
    for (const guard of [{ kind: "none" }, { kind: "guarded", entry: "/a", mode: "auto" }] as const) {
      const launch = buildLaunch({ task: "t", guard, requestedModel: "cheap/model", parentModel: "strong/model", environment: {} });
      assert.deepEqual(launch.args.slice(launch.args.indexOf("--model"), launch.args.indexOf("--model") + 2), ["--model", "cheap/model"]);
    }
  });

  it("has a guarded child checked by the classifier model of the config, else by the parent's model", () => {
    const base = { task: "t", requestedModel: "cheap/model", parentModel: "strong/model", environment: {} };
    const configured = buildLaunch({ ...base, guard: { kind: "guarded", entry: "/a", mode: "auto", classifierModel: "judge/model" } });
    assert.equal(configured.environment[CLASSIFIER_MODEL_ENV], "judge/model");
    const fallback = buildLaunch({ ...base, guard: { kind: "guarded", entry: "/a", mode: "auto" } });
    assert.equal(fallback.environment[CLASSIFIER_MODEL_ENV], "strong/model");
  });

  it("passes on the log switch of the parent, and drops a stale one", () => {
    const base = { task: "t", environment: { [LOG_ENABLED_ENV]: "1" } };
    const off = buildLaunch({ ...base, guard: { kind: "guarded", entry: "/a", mode: "auto", logEnabled: false } });
    assert.equal(off.environment[LOG_ENABLED_ENV], "0");
    const on = buildLaunch({ ...base, guard: { kind: "guarded", entry: "/a", mode: "auto", logEnabled: true } });
    assert.equal(on.environment[LOG_ENABLED_ENV], "1");
    const unknown = buildLaunch({ ...base, guard: { kind: "guarded", entry: "/a", mode: "auto" } });
    assert.equal(unknown.environment[LOG_ENABLED_ENV], undefined);
  });

  it("does not let a guarded child pick a model when nothing is known to check it", () => {
    const launch = buildLaunch({ task: "t", guard: { kind: "guarded", entry: "/a", mode: "auto" }, requestedModel: "cheap/model", defaultModel: "cheap/model", environment: {} });
    assert.ok(!launch.args.includes("--model"));
    assert.equal(launch.environment[CLASSIFIER_MODEL_ENV], undefined);
  });

  it("overwrites a classifier model that was already in the environment, and sets none without automode", () => {
    const guarded = buildLaunch({
      task: "t",
      guard: { kind: "guarded", entry: "/a", mode: "auto" },
      parentModel: "strong/model",
      environment: { [CLASSIFIER_MODEL_ENV]: "weak/model" },
    });
    assert.equal(guarded.environment[CLASSIFIER_MODEL_ENV], "strong/model");
    const free = buildLaunch({ task: "t", guard: { kind: "none" }, parentModel: "strong/model", environment: {} });
    assert.equal(free.environment[CLASSIFIER_MODEL_ENV], undefined);
  });

  it("gives a guarded child the log file of the parent, and an unguarded one nothing", () => {
    const guarded = buildLaunch({ task: "t", guard: { kind: "guarded", entry: "/a", mode: "auto", logFile: "/l/a.jsonl" }, environment: {} });
    assert.equal(guarded.environment.PI_AUTOMODE_LOG_FILE, "/l/a.jsonl");
    const free = buildLaunch({ task: "t", guard: { kind: "none" }, environment: {} });
    assert.equal(free.environment.PI_AUTOMODE_LOG_FILE, undefined);
  });

  it("uses the configured model when none was asked for", () => {
    const modelAfterFlag = (args: string[]) => args[args.indexOf("--model") + 1];
    const base = { task: "t", parentModel: "strong/model", defaultModel: "cheap/model", environment: {} };
    assert.equal(modelAfterFlag(buildLaunch({ ...base, guard: { kind: "none" } }).args), "cheap/model");
    assert.equal(modelAfterFlag(buildLaunch({ ...base, guard: { kind: "none" }, requestedModel: "asked/model" }).args), "asked/model");
    assert.equal(modelAfterFlag(buildLaunch({ ...base, guard: { kind: "guarded", entry: "/a", mode: "auto" } }).args), "cheap/model");
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
