import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChildOutput, runChild } from "../src/run.ts";

const assistant = (text: string, extra: object = {}) =>
  JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], ...extra } });

describe("ChildOutput", () => {
  it("keeps the text of the last assistant message", () => {
    const output = new ChildOutput();
    output.push(`${assistant("first")}\n${assistant("second")}\n`);
    output.finish();
    assert.equal(output.text, "second");
    assert.equal(output.failure, undefined);
  });

  it("joins lines that arrive in pieces, and reads a last line without a newline", () => {
    const output = new ChildOutput();
    const line = assistant("whole");
    output.push(line.slice(0, 10));
    output.push(line.slice(10));
    output.finish();
    assert.equal(output.text, "whole");
  });

  it("ignores user messages, junk and other events", () => {
    const output = new ChildOutput();
    output.push('{"type":"message_end","message":{"role":"user","content":"hi"}}\nnot json\n{"type":"agent_start"}\n');
    output.finish();
    assert.equal(output.text, "");
  });

  it("reports an error or an abort", () => {
    const failed = new ChildOutput();
    failed.push(`${assistant("", { stopReason: "error", errorMessage: "boom" })}\n`);
    assert.equal(failed.failure, "boom");
    const aborted = new ChildOutput();
    aborted.push(`${assistant("", { stopReason: "aborted" })}\n`);
    assert.match(aborted.failure ?? "", /aborted/);
    const truncated = new ChildOutput();
    truncated.push(`${assistant("cut off", { stopReason: "length" })}\n`);
    assert.match(truncated.failure ?? "", /length/);
  });
});

describe("runChild", () => {
  const node = process.execPath;
  const base = {
    command: node,
    cwd: process.cwd(),
    environment: process.env,
    signal: undefined,
    stallTimeoutMs: 60_000,
    maxStderrChars: 20_000,
  };

  it("returns the final text and the exit code of the child", async () => {
    const script = `console.log(${JSON.stringify(assistant("done"))})`;
    const result = await runChild({ ...base, args: ["-e", script] });
    assert.deepEqual(result, { text: "done", exitCode: 0, stderr: "", failure: undefined });
  });

  it("gives the child the environment it was passed", async () => {
    const script = `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:process.env.X_TEST}]}}))`;
    const result = await runChild({ ...base, args: ["-e", script], environment: { ...process.env, X_TEST: "yes" } });
    assert.equal(result.text, "yes");
  });

  it("reports a non-zero exit and stderr", async () => {
    const result = await runChild({ ...base, args: ["-e", 'console.error("bad"); process.exit(3)'] });
    assert.equal(result.exitCode, 3);
    assert.equal(result.stderr.trim(), "bad");
  });

  it("reports a command that cannot start", async () => {
    const result = await runChild({ ...base, command: "/no/such/command", args: [] });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /ENOENT/);
  });

  it("kills the child when the signal aborts", async () => {
    const controller = new AbortController();
    const running = runChild({ ...base, args: ["-e", "setInterval(() => {}, 1000)"], signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await running;
    assert.notEqual(result.exitCode, 0);
  });

  it("kills a child that prints nothing for the stall timeout", async () => {
    const result = await runChild({ ...base, args: ["-e", "setInterval(() => {}, 1000)"], stallTimeoutMs: 100 });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /printed nothing for 100 ms/);
  });

  it("does not kill a child that keeps printing", async () => {
    const script = `let n = 0; const timer = setInterval(() => { process.stderr.write("."); if (++n === 8) { clearInterval(timer); console.log(${JSON.stringify(assistant("done"))}); } }, 50)`;
    const result = await runChild({ ...base, args: ["-e", script], stallTimeoutMs: 200 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.text, "done");
  });

  it("fails a child that exits cleanly after the timeout kill", async () => {
    const script = `process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)`;
    const result = await runChild({ ...base, args: ["-e", script], stallTimeoutMs: 200 });
    assert.equal(result.exitCode, 1);
  });

  it("keeps only the end of a long stderr", async () => {
    const script = `process.stderr.write("x".repeat(3000) + "END")`;
    const result = await runChild({ ...base, args: ["-e", script], maxStderrChars: 1000 });
    assert.equal(result.stderr.length, 1000);
    assert.ok(result.stderr.endsWith("END"));
  });
});
