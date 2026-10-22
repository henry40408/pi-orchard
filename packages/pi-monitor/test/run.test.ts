import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startMonitorProcess } from "../src/run.ts";

const shell = { path: "/bin/sh", args: ["-c"] };

function start(command: string) {
  const out: string[] = [];
  const err: string[] = [];
  const process = startMonitorProcess({
    command,
    cwd: ".",
    shell,
    onData: (stream, chunk) => (stream === "stdout" ? out : err).push(chunk),
  });
  return { process, out, err };
}

describe("startMonitorProcess", () => {
  it("passes both streams and the exit code", async () => {
    const { process, out, err } = start("echo hello; echo oops >&2; exit 3");
    const exit = await process.done;
    assert.equal(out.join(""), "hello\n");
    assert.equal(err.join(""), "oops\n");
    assert.equal(exit.exitCode, 3);
    assert.equal(exit.startError, undefined);
  });

  it("reports a shell that cannot start", async () => {
    const process = startMonitorProcess({ command: "true", cwd: ".", shell: { path: "/nonexistent/sh", args: ["-c"] }, onData: () => {} });
    const exit = await process.done;
    assert.ok(exit.startError);
  });

  it("kills the children of the shell too", async () => {
    const { process, out } = start("sleep 30 & echo $!; wait");
    while (!out.join("").includes("\n")) await new Promise((resolve) => setTimeout(resolve, 10));
    const childPid = Number(out.join("").trim());
    process.kill();
    const exit = await process.done;
    assert.ok(exit.signal === "SIGTERM" || exit.exitCode !== 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(() => globalThis.process.kill(childPid, 0));
  });
});
