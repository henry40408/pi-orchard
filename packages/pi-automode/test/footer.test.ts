import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FOOTER_KEY, footerText } from "../src/footer.ts";
import { AutomodeState } from "../src/state.ts";

function setup(userConfig?: string) {
  const root = mkdtempSync(join(tmpdir(), "automode-footer-"));
  mkdirSync(join(root, "agent"));
  if (userConfig !== undefined) writeFileSync(join(root, "agent", "automode.json"), userConfig);
  return { state: new AutomodeState(join(root, "agent")), cwd: root };
}

describe("footerText", () => {
  it("names the mode", () => {
    const { state, cwd } = setup();
    assert.equal(footerText(state, cwd), "🛡️ automode: auto");
    state.setMode(cwd, "rules");
    assert.equal(footerText(state, cwd), "🛡️ automode: rules");
  });

  it("warns when automode is off", () => {
    const { state, cwd } = setup();
    state.setMode(cwd, "off");
    assert.equal(footerText(state, cwd), "⚠️ automode: OFF");
  });

  it("flags a config error", () => {
    const { state, cwd } = setup("{ nope");
    assert.equal(footerText(state, cwd), "⚠️ automode: ask · config error");
  });

  it("survives what statusline extensions do to the text", () => {
    const states = [setup(), setup("{ nope")];
    states[0]?.state.setMode(states[0].cwd, "off");
    for (const entry of [setup(), ...states]) {
      const text = footerText(entry.state, entry.cwd);
      assert.ok(!text.startsWith(`${FOOTER_KEY}:`), "a leading key prefix is cut");
      assert.ok(/^\p{Extended_Pictographic}/u.test(text), "a leading emoji becomes the icon");
      assert.ok(!text.trimEnd().endsWith(")"), "a trailing parenthesis is dropped");
      assert.ok(text.includes("automode:"), "the name stays after the icon");
    }
  });
});
