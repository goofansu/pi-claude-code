import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { getClaudeStatus, INSTALL_HINT, LOGIN_HINT } from "../src/claude-cli.ts";
import { createClaudeCodeProvider } from "../src/provider.ts";

async function until(predicate: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}

// A real subprocess boundary, with no Claude installation or credentials. Each
// invocation records its PID before waiting for the test to release its output.
async function fakeClaude(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi auth status-"));
  const started = join(root, "started");
  const response = join(root, "response.json");
  await mkdir(started);
  const script = join(root, "claude.cjs");
  await writeFile(script, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['auth', 'status'])) process.exit(99);
const observed = Object.fromEntries(['HOME', 'USERPROFILE', 'PI_CLAUDE_CODE_COMMAND', 'PI_CLAUDE_CODE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR', 'PATH', 'PATHEXT', 'PI_CLAUDE_CODE_POWERSHELL', 'COMSPEC', 'FAKE_CREDENTIAL', 'ANTHROPIC_API_KEY']
  .map(key => [key, process.env[key]]));
const record = path.join(${JSON.stringify(started)}, process.pid + '.json');
fs.writeFileSync(record + '.tmp', JSON.stringify({ pid: process.pid }));
fs.renameSync(record + '.tmp', record);
const deadline = setTimeout(() => process.exit(98), 5000);
const timer = setInterval(() => {
  let result;
  try { result = JSON.parse(fs.readFileSync(${JSON.stringify(response)}, 'utf8')); }
  catch { return; }
  clearInterval(timer);
  clearTimeout(deadline);
  process.stdout.write(result.stdout === 'echo-env'
    ? JSON.stringify({ loggedIn: true, authMethod: JSON.stringify(observed) }) : result.stdout);
  process.stderr.write(result.stderr || '');
  process.exitCode = result.code || 0;
}, 10);
`);
  const command = process.platform === "win32" ? join(root, "claude.cmd") : script;
  if (command !== script) await writeFile(command, `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`);
  await chmod(command, 0o755);
  const env: Record<string, string | undefined> = {
    // Only OS launch essentials, never ambient Claude/auth configuration.
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    COMSPEC: process.env.COMSPEC,
    HOME: root,
    USERPROFILE: root,
    PI_CLAUDE_CODE_COMMAND: command,
  };
  const calls: Promise<unknown>[] = [];
  const track = <T>(call: Promise<T>): Promise<T> => {
    calls.push(call);
    // Tests may deliberately abort before awaiting the result.
    void call.catch(() => {});
    return call;
  };
  const release = (stdout = '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}', code = 0, stderr = "") =>
    writeFile(response, JSON.stringify({ stdout, code, stderr }));
  const launches = async (): Promise<{ pid: number }[]> => Promise.all(
    (await readdir(started)).filter(file => file.endsWith(".json"))
      .map(async (file) => JSON.parse(await readFile(join(started, file), "utf8"))),
  );
  t.after(async () => {
    await release();
    await Promise.allSettled(calls);
    await rm(root, { recursive: true, force: true });
  });
  return {
    root, command, script, env, release, launches, track,
    async started(count = 1) {
      await until(async () => (await launches()).length >= count, `expected ${count} fake Claude processes`);
    },
    check(overrides: Record<string, string | undefined> = {}, signal?: AbortSignal) {
      return track(getClaudeStatus({ ...env, ...overrides }, signal));
    },
  };
}

test("12 overlapping auth status checks share one subprocess", { timeout: 10_000 }, async (t) => {
  const fake = await fakeClaude(t);
  const checks = Array.from({ length: 12 }, () => fake.check());
  await fake.started();
  await fake.release();
  const results = await Promise.all(checks);
  for (const result of results) {
    assert.deepEqual(result, {
      available: true, loggedIn: true, subscription: true, command: fake.command,
      authMethod: "claude.ai", plan: "max", detail: undefined,
    });
  }
  const count = (await fake.launches()).length;
  t.diagnostic(`12 concurrent checks launched ${count} subprocesses`);
  assert.equal(count, 1);
  results[0].loggedIn = false;
  assert.equal(results[1].loggedIn, true, "callers must not share mutable status objects");
});

// Mutate the fake CLI's response, not the environment, so each round asks the
// same installation again. Neither success, logout nor failure may be cached.
test("settled auth status checks are fresh and preserve logout versus diagnostics", async (t) => {
  const fake = await fakeClaude(t);
  const scenarios = [
    { stdout: '{"loggedIn":true,"subscriptionType":"pro"}', code: 0, loggedIn: true },
    { stdout: '{"loggedIn":false}', code: 1, loggedIn: false, detail: LOGIN_HINT },
    { stdout: "not json", code: 3, diagnostic: true, output: "not json" },
    { stdout: "", stderr: "CLI unavailable", code: 7, diagnostic: true, output: "CLI unavailable" },
    { stdout: "", code: 0, diagnostic: true, output: "(no output)" },
    { stdout: 'notice\n{"loggedIn":true,"authMethod":"claude.ai"}', code: 0, loggedIn: true },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    await fake.release(scenario.stdout, scenario.code, scenario.stderr);
    const results = await Promise.all(Array.from({ length: 12 }, () => fake.check()));
    for (const status of results) {
      assert.equal(status.available, true);
      assert.equal(status.loggedIn, scenario.loggedIn ?? false);
      assert.equal(status.subscription, index === 0);
      assert.equal(status.diagnostic, scenario.diagnostic);
      assert.equal(status.detail, scenario.diagnostic
        ? `Claude Code status check failed (exit ${scenario.code}): unexpected auth status output: ${scenario.output}`
        : scenario.detail);
    }
    assert.equal((await fake.launches()).length, index + 1);
  }
});

for (const cancelled of [0, 1]) {
  test(`cancelling ${cancelled === 0 ? "the first" : "a joining"} waiter leaves other checks running`, async (t) => {
    const fake = await fakeClaude(t);
    const controllers = [new AbortController(), new AbortController()];
    const checks = controllers.map((controller) => fake.check({}, controller.signal));
    const withoutSignal = fake.check();
    await fake.started();
    const reason = new Error("only this caller cancelled");
    controllers[cancelled].abort(reason);
    await assert.rejects(checks[cancelled], (error) => error === reason);
    // A third caller can still join after the cancellation.
    const joining = fake.check();
    await fake.release();
    for (const result of await Promise.all([checks[1 - cancelled], withoutSignal, joining])) {
      assert.equal(result.subscription, true, result.detail);
    }
    assert.equal((await fake.launches()).length, 1);
  });
}

async function stopped(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}

test("the last cancellation promptly stops the process and an immediate new caller starts fresh", async (t) => {
  const fake = await fakeClaude(t);
  const controllers = Array.from({ length: 12 }, () => new AbortController());
  const checks = controllers.map((controller) => fake.check({}, controller.signal));
  await fake.started();
  const [{ pid }] = await fake.launches();
  const reasons = controllers.map((_, index) => new Error(`cancel ${index}`));
  controllers.forEach((controller, index) => controller.abort(reasons[index]));
  // Do not wait for old promise cleanup: it must not evict this replacement.
  const replacement = fake.check();
  await Promise.all(checks.map((check, index) => assert.rejects(check, (error) => error === reasons[index])));
  await until(() => stopped(pid), "last cancellation should stop the owned process promptly");
  await fake.started(2);
  const joining = fake.check();
  await fake.release();
  assert.equal((await replacement).subscription, true);
  assert.equal((await joining).subscription, true);
  assert.equal((await fake.launches()).length, 2);
});

test("preaborted and immediately cancelled checks start no process", async (t) => {
  const fake = await fakeClaude(t);
  const controller = new AbortController();
  const reason = new Error("already cancelled");
  controller.abort(reason);
  for (const command of [fake.command, join(fake.root, "missing")]) {
    await assert.rejects(fake.check({ PI_CLAUDE_CODE_COMMAND: command }, controller.signal), (error) => error === reason);
  }
  const immediate = new AbortController();
  const checks = Array.from({ length: 12 }, () => fake.check({}, immediate.signal));
  immediate.abort(reason);
  await Promise.all(checks.map((check) => assert.rejects(check, (error) => error === reason)));
  await fake.release();
  assert.equal((await fake.check()).subscription, true);
  assert.equal((await fake.launches()).length, 1, "only the later uncancelled check may start a process");
});

test("different commands never share status checks", async (t) => {
  const fake = await fakeClaude(t);
  const other = join(fake.root, process.platform === "win32" ? "other.cmd" : "other.cjs");
  await writeFile(other, await readFile(fake.command));
  await chmod(other, 0o755);
  const first = fake.check();
  const second = fake.check({ PI_CLAUDE_CODE_COMMAND: other });
  await fake.started(2);
  await fake.release();
  assert.equal((await first).command, fake.command);
  assert.equal((await second).command, other);
  assert.equal((await fake.launches()).length, 2);
});

test("Windows case-duplicate command overrides preserve resolution order", { skip: process.platform !== "win32" }, async (t) => {
  const fake = await fakeClaude(t);
  const other = join(fake.root, "other.cmd");
  await writeFile(other, await readFile(fake.command));
  const { PI_CLAUDE_CODE_COMMAND: _, ...env } = fake.env;
  const firstEnv = { ...env, Pi_Claude_Code_Command: fake.command, pi_claude_code_command: other };
  const secondEnv = Object.fromEntries(Object.entries(firstEnv).reverse());
  const first = fake.track(getClaudeStatus(firstEnv));
  const second = fake.track(getClaudeStatus(secondEnv));
  await fake.started(2);
  await fake.release();
  assert.equal((await first).command, fake.command);
  assert.equal((await second).command, other);
  assert.equal((await fake.launches()).length, 2);
});

test("status checks are isolated by the full child environment", async (t) => {
  for (const name of ["HOME", "USERPROFILE", "PI_CLAUDE_CODE_CONFIG_DIR", "CLAUDE_CONFIG_DIR", "PATH",
    "PATHEXT", "PI_CLAUDE_CODE_POWERSHELL", "COMSPEC", "FAKE_CREDENTIAL"]) {
    await t.test(name, async (t) => {
      const fake = await fakeClaude(t);
      const value = name === "PATH" ? `${fake.env.PATH}${delimiter}${fake.root}`
        : name === "COMSPEC" && process.platform === "win32"
          ? (fake.env.COMSPEC === fake.env.COMSPEC!.toUpperCase() ? fake.env.COMSPEC!.toLowerCase() : fake.env.COMSPEC!.toUpperCase())
          : join(fake.root, "different");
      const first = fake.check();
      const second = fake.check({ [name]: value });
      await fake.started(2);
      await fake.release("echo-env");
      const before = JSON.parse((await first).authMethod!);
      const after = JSON.parse((await second).authMethod!);
      assert.equal(before[name], fake.env[name]);
      assert.equal(after[name], value);
      if (name === "PI_CLAUDE_CODE_CONFIG_DIR") assert.equal(after.CLAUDE_CONFIG_DIR, value);
      assert.equal((await fake.launches()).length, 2);
    });
  }
});

test("equivalent snapshots share regardless of key order, stripped API keys, or undefined entries", async (t) => {
  const fake = await fakeClaude(t);
  const env = Object.freeze({ ...fake.env, ANTHROPIC_API_KEY: "synthetic-first", UNUSED: undefined });
  const reordered = Object.freeze(Object.fromEntries(Object.entries({ ...fake.env, ANTHROPIC_API_KEY: "synthetic-second" }).reverse()));
  const first = fake.track(getClaudeStatus(env));
  const second = fake.track(getClaudeStatus(reordered));
  await fake.started();
  await fake.release("echo-env");
  assert.equal(JSON.parse((await first).authMethod!).ANTHROPIC_API_KEY, undefined);
  assert.equal(JSON.parse((await second).authMethod!).ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, "synthetic-first");
  assert.equal(reordered.ANTHROPIC_API_KEY, "synthetic-second");
  assert.equal((await fake.launches()).length, 1);
});

test("a caller's environment is snapshotted before asynchronous executable lookup", async (t) => {
  const fake = await fakeClaude(t);
  const env = { ...fake.env, FAKE_CREDENTIAL: "first" };
  const first = fake.track(getClaudeStatus(env));
  env.FAKE_CREDENTIAL = "second";
  const second = fake.track(getClaudeStatus(env));
  await fake.started(2);
  await fake.release("echo-env");
  assert.equal(JSON.parse((await first).authMethod!).FAKE_CREDENTIAL, "first");
  assert.equal(JSON.parse((await second).authMethod!).FAKE_CREDENTIAL, "second");
});

test("missing installations and failed launches are not cached or confused with logout", async (t) => {
  const fake = await fakeClaude(t);
  const command = join(fake.root, process.platform === "win32" ? "new.cmd" : "new.cjs");
  const env = { PI_CLAUDE_CODE_COMMAND: command };
  const unavailable = await Promise.all(Array.from({ length: 12 }, () => fake.check(env)));
  for (const status of unavailable) {
    assert.deepEqual(status, { available: false, loggedIn: false, subscription: false, detail: INSTALL_HINT });
  }
  await writeFile(command, process.platform === "win32" ? "@ECHO off\r\nexit /b 9\r\n" : "#!/no-such-claude-interpreter\n");
  await chmod(command, 0o755);
  const failures = await Promise.all(Array.from({ length: 12 }, () => fake.check(env)));
  for (const status of failures) {
    assert.equal(status.available, true);
    assert.equal(status.loggedIn, false);
    assert.equal(status.diagnostic, true);
    assert.match(status.detail!, /Claude Code status check failed/);
    assert.notEqual(status.detail, LOGIN_HINT);
  }
  await writeFile(command, await readFile(fake.command));
  await fake.release();
  assert.equal((await fake.check(env)).subscription, true);
  assert.equal((await fake.launches()).length, 1);
});

test("shared checks retain the capture deadline and retry freshly after timeout", async (t) => {
  const fake = await fakeClaude(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = fake.check();
  await fake.started();
  const [{ pid }] = await fake.launches();
  t.mock.timers.tick(19_999);
  const late = fake.check();
  t.mock.timers.tick(1);
  for (const status of await Promise.all([first, late])) {
    assert.equal(status.diagnostic, true);
    assert.equal(status.detail, "Claude Code status check failed: Claude Code command timed out after 20000ms");
  }
  await until(() => stopped(pid), "timeout should stop the owned process");
  await fake.release();
  assert.equal((await fake.check()).subscription, true);
  assert.equal((await fake.launches()).length, 2);
});

test("provider availability checks coalesce and stay fresh", async (t) => {
  const fake = await fakeClaude(t);
  // provider.check builds on process.env; keep even this fake-process test's
  // account directories isolated without changing any real credentials.
  for (const name of ["HOME", "USERPROFILE"]) {
    const original = process.env[name];
    process.env[name] = fake.root;
    t.after(() => { if (original === undefined) delete process.env[name]; else process.env[name] = original; });
  }
  const provider = createClaudeCodeProvider();
  const check = () => fake.track(provider.auth.apiKey!.check!({
    ctx: { env: async (name) => name === "PI_CLAUDE_CODE_COMMAND" ? fake.command
      : name === "PI_CLAUDE_CODE_CONFIG_DIR" ? fake.root : undefined, fileExists: async () => false },
    signal: new AbortController().signal,
  }));
  const checks = Array.from({ length: 12 }, check);
  await fake.started();
  await fake.release();
  for (const result of await Promise.all(checks)) assert.deepEqual(result, { type: "oauth", source: "Claude Code max" });
  assert.equal((await fake.launches()).length, 1);
  await fake.release('{"loggedIn":false}', 1);
  for (const result of await Promise.all(Array.from({ length: 12 }, check))) assert.equal(result, undefined);
  assert.equal((await fake.launches()).length, 2);
});
