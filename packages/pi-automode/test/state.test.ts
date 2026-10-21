import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AutomodeState, configPaths, PARENT_MODE_ENV, parentModeFromEnvironment } from "../src/state.ts";

function setup(userConfig?: string) {
  const root = mkdtempSync(join(tmpdir(), "automode-state-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  if (userConfig !== undefined) writeFileSync(configPaths(agentDir, cwd).user, userConfig);
  return { state: new AutomodeState(agentDir), root, agentDir, cwd };
}

describe("AutomodeState", () => {
  it("uses the default mode without files", () => {
    const { state, cwd } = setup();
    assert.equal(state.config(cwd).mode, "auto");
    assert.deepEqual(state.status(cwd), { mode: "auto", active: true });
  });

  it("reads the user file", () => {
    const { state, cwd } = setup('{"mode":"rules"}');
    assert.equal(state.config(cwd).mode, "rules");
  });

  it("setMode overrides the mode until reload", () => {
    const { state, cwd } = setup('{"mode":"rules"}');
    assert.equal(state.setMode(cwd, "off"), undefined);
    assert.deepEqual(state.status(cwd), { mode: "off", active: false });
    state.reload(cwd);
    assert.equal(state.status(cwd).mode, "rules");
  });

  it("refuses setMode while a config file is invalid and falls back to ask", () => {
    const { state, cwd } = setup("{ not json");
    assert.equal(state.config(cwd).mode, "ask");
    assert.match(state.setMode(cwd, "off") ?? "", /invalid/);
    assert.equal(state.status(cwd).mode, "ask");
  });

  it("never goes below the parent mode", () => {
    const { agentDir, cwd } = setup('{"mode":"auto"}');
    const child = new AutomodeState(agentDir, "rules");
    assert.equal(child.config(cwd).mode, "rules");
    assert.match(child.setMode(cwd, "off") ?? "", /parent session/);
    assert.equal(child.setMode(cwd, "ask"), undefined);
    assert.equal(child.config(cwd).mode, "ask");
    child.reload(cwd);
    assert.equal(child.config(cwd).mode, "rules");
  });

  it("keeps a stricter own mode over a looser parent mode", () => {
    const { agentDir, cwd } = setup('{"mode":"ask"}');
    assert.equal(new AutomodeState(agentDir, "auto").config(cwd).mode, "ask");
  });

  it("reads the parent mode from the environment, and treats junk as ask", () => {
    assert.equal(parentModeFromEnvironment({}), undefined);
    assert.equal(parentModeFromEnvironment({ [PARENT_MODE_ENV]: "rules" }), "rules");
    assert.equal(parentModeFromEnvironment({ [PARENT_MODE_ENV]: "yolo" }), "ask");
    assert.equal(parentModeFromEnvironment({ [PARENT_MODE_ENV]: "" }), "ask");
  });

  it("keeps the mode override when the working directory changes", () => {
    const { state, cwd, root } = setup();
    state.setMode(cwd, "rules");
    assert.equal(state.config(join(root, "elsewhere")).mode, "rules");
    assert.equal(state.status().mode, "rules");
  });

  it("reads the config again for another working directory", () => {
    const { state, cwd, root, agentDir } = setup();
    state.config(cwd);
    const other = join(root, "other");
    mkdirSync(join(other, ".pi"), { recursive: true });
    writeFileSync(configPaths(agentDir, other).project, '{"mode":"ask"}');
    assert.equal(state.config(other).mode, "ask");
  });
});
