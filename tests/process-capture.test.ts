import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureProcess, getClaudeStatus, LOGIN_HINT } from "../src/claude-cli.ts";

const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));

// The descendant inherits the pipes but cannot write until its parent has exited.
// This makes the exit-before-output ordering deterministic, not load-dependent.
function delayedOutput(stdout: string, stderr = "", delay = 50): string {
  const writer = `
    process.stdin.resume();
    process.stdin.on('end', () => setTimeout(() => {
      process.stdout.write(${JSON.stringify(stdout)});
      process.stderr.write(${JSON.stringify(stderr)});
    }, ${delay}));
  `;
  return `
    const { spawn } = require('node:child_process');
    const writer = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], { stdio: ['pipe', 1, 2] });
    writer.once('spawn', () => process.exit(0));
  `;
}

test("capture waits for stdout and stderr after process exit", async () => {
  const result = await captureProcess(process.execPath, ["-e", delayedOutput("complete output", "late diagnostic")], env);
  assert.deepEqual(result, { code: 0, stdout: "complete output", stderr: "late diagnostic" });
});

test("capture drains output larger than pipe buffers", async () => {
  const result = await captureProcess(process.execPath, ["-e", `
    process.stdout.write('x'.repeat(500_000));
    process.stderr.write('y'.repeat(60_000));
    process.exitCode = 7;
  `], env);
  assert.deepEqual(result, { code: 7, stdout: "x".repeat(500_000), stderr: "y".repeat(60_000) });
});

test("capture bounds waiting for inherited pipes", { timeout: 5_000 }, async () => {
  await assert.rejects(
    captureProcess(process.execPath, ["-e", delayedOutput("", "", 1_000)], env, undefined, 300),
    /Claude Code command timed out after 300ms/,
  );
});

test("capture aborts while waiting for inherited pipes", { timeout: 5_000 }, async () => {
  const controller = new AbortController();
  const reason = new Error("test cancellation");
  const timer = setTimeout(() => controller.abort(reason), 300);
  try {
    await assert.rejects(
      captureProcess(process.execPath, ["-e", delayedOutput("", "", 1_000)], env, controller.signal),
      (error) => error === reason,
    );
  } finally {
    clearTimeout(timer);
  }
});

test("capture preserves spawn failures, signals, and pre-aborted cancellation", async () => {
  await assert.rejects(captureProcess(join(tmpdir(), "missing-claude-command", "claude"), [], env), /ENOENT/);
  const immediate = new AbortController();
  const spawning = captureProcess(join(tmpdir(), "missing-claude-command", "claude"), [], env, immediate.signal);
  immediate.abort(new Error("cancel during spawn"));
  await assert.rejects(spawning, /cancel during spawn/);

  const controller = new AbortController();
  controller.abort(new Error("already aborted"));
  await assert.rejects(captureProcess(process.execPath, [], env, controller.signal), /already aborted/);
  await assert.rejects(
    captureProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], env, undefined, 100),
    /timed out/,
  );
  if (process.platform !== "win32") {
    await assert.rejects(
      captureProcess(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], env),
      /Claude Code exited from signal SIGTERM/,
    );
  }
});

test("auth status waits for JSON after process exit", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-status-drain-"));
  const command = join(root, "claude.cjs");
  try {
    await writeFile(command, `#!${process.execPath}\n${delayedOutput(JSON.stringify({ loggedIn: true, subscriptionType: "max" }))}`);
    await chmod(command, 0o755);
    const statuses = await Promise.all(Array.from({ length: 12 }, () =>
      getClaudeStatus({ ...env, PI_CLAUDE_CODE_COMMAND: command })));
    for (const status of statuses) {
      assert.equal(status.loggedIn, true, status.detail);
      assert.equal(status.subscription, true);
      assert.equal(status.diagnostic, undefined);
    }

    // Waiting for output must not turn real CLI failures into logged-in success.
    for (const [stdout, stderr, expected] of [
      ["", "", "(no output)"],
      ["not json", "", "not json"],
      ["", "late CLI failure", "late CLI failure"],
    ] as const) {
      await writeFile(command, `#!${process.execPath}\n${delayedOutput(stdout, stderr)}`);
      const failed = await getClaudeStatus({ ...env, PI_CLAUDE_CODE_COMMAND: command });
      assert.equal(failed.loggedIn, false);
      assert.equal(failed.diagnostic, true);
      assert.equal(failed.detail, `Claude Code status check failed (exit 0): unexpected auth status output: ${expected}`);
    }
    await writeFile(command, `#!${process.execPath}\nconsole.log(JSON.stringify({ loggedIn: false })); process.exitCode = 1;`);
    const loggedOut = await getClaudeStatus({ ...env, PI_CLAUDE_CODE_COMMAND: command });
    assert.equal(loggedOut.loggedIn, false);
    assert.equal(loggedOut.diagnostic, undefined);
    assert.equal(loggedOut.detail, LOGIN_HINT);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
