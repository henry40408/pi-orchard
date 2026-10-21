import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { footerText } from "../src/footer.ts";
import { AutomodeState } from "../src/state.ts";

function setup(userConfig?: string) {
  const root = mkdtempSync(join(tmpdir(), "automode-footer-"));
  mkdirSync(join(root, "agent"));
  if (userConfig !== undefined) writeFileSync(join(root, "agent", "automode.json"), userConfig);
  return { state: new AutomodeState(join(root, "agent")), cwd: root };
}

describe("footerText", () => {
  it("names the mode, with a prefix because the footer hides the key", () => {
    const { state, cwd } = setup();
    assert.equal(footerText(state, cwd), "automode: auto");
    state.setMode(cwd, "rules");
    assert.equal(footerText(state, cwd), "automode: rules");
  });

  it("shouts when automode is off", () => {
    const { state, cwd } = setup();
    state.setMode(cwd, "off");
    assert.equal(footerText(state, cwd), "automode: OFF");
  });

  it("flags a config error", () => {
    const { state, cwd } = setup("{ nope");
    assert.equal(footerText(state, cwd), "automode: ask (config error)");
  });
});
