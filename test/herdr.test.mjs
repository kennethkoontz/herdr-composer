import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createWorktree,
  defaultConfig,
  worktreeBranch,
} from "../lib/herdr.mjs";
import {
  confirmSubmitted,
  launchSelection,
  looksLikeStartupDialog,
  waitForPromptReady,
} from "../lib/launch.mjs";

const TRUST_DIALOG_SCREEN = `
 Accessing workspace:
 /Users/ken/.herdr/worktrees/demo/composer-fix-login

 Quick safety check: Is this a project you created or one you trust?
 Claude Code'll be able to read, edit, and execute files here.

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
`;

const READY_SCREEN = `
╭─── Claude Code v2.1.220 ─────────────────────────────╮
│   Welcome back Ken!                                  │
│   Run /init to create a CLAUDE.md file               │
╰──────────────────────────────────────────────────────╯
──────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────
  demo main                                    0K/1000K
`;

function installFakeHerdr() {
  const dir = mkdtempSync(join(tmpdir(), "herdr-composer-test-"));
  const bin = join(dir, "herdr");
  const log = join(dir, "calls.jsonl");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(args) + "\\n");

// Plain-text screen reads: optionally a folder-trust dialog.
if (args[0] === "agent" && args[1] === "read") {
  process.stdout.write(process.env.FAKE_HERDR_SCREEN || "❯\\n");
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "explain") {
  process.stdout.write(JSON.stringify({ state: "idle", visible_blocker: false }) + "\\n");
  process.exit(0);
}
// Fail the first N agent starts with the real pane-not-ready error.
if (args[0] === "agent" && args[1] === "start" && process.env.FAKE_HERDR_BUSY) {
  const counter = process.env.FAKE_HERDR_BUSY_COUNT;
  let seen = 0;
  try {
    seen = Number(readFileSync(counter, "utf8")) || 0;
  } catch {}
  if (seen < Number(process.env.FAKE_HERDR_BUSY)) {
    writeFileSync(counter, String(seen + 1));
    process.stderr.write(
      JSON.stringify({
        error: { code: "agent_pane_busy", message: "not an available shell" },
        id: "cli:agent:start",
      }) + "\\n",
    );
    process.exit(1);
  }
}

let result = {};
if (args[0] === "worktree" && args[1] === "create") {
  result = {
    workspace: { workspace_id: "wt-1" },
    tab: { tab_id: "wt-tab" },
    root_pane: { pane_id: "wt-1:p1", cwd: "/tmp/checkout" },
    worktree: { path: "/tmp/checkout", branch: "composer/test" }
  };
} else if (args[0] === "tab" && args[1] === "create") {
  result = { tab: { tab_id: "tab-2" }, root_pane: { pane_id: "w1:p2" } };
} else if (args[0] === "agent" && args[1] === "get") {
  result = { agent: { agent_status: process.env.FAKE_HERDR_STATUS || "working" } };
} else if (args[0] === "agent" && args[1] === "list") {
  result = { agents: [] };
} else if (args[0] === "agent" && args[1] === "start") {
  const paneIndex = args.indexOf("--pane");
  result = { agent: { pane_id: args[paneIndex + 1] } };
}
process.stdout.write(JSON.stringify({ result }) + "\\n");
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log, busyCount: join(dir, "busy-count") };
}

function useFakeHerdr() {
  const fake = installFakeHerdr();
  process.env.HERDR_BIN_PATH = fake.bin;
  process.env.FAKE_HERDR_LOG = fake.log;
  process.env.FAKE_HERDR_BUSY_COUNT = fake.busyCount;
  delete process.env.FAKE_HERDR_SCREEN;
  delete process.env.FAKE_HERDR_BUSY;
  delete process.env.FAKE_HERDR_STATUS;
  return fake;
}

function callsFrom(log) {
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("worktrees are enabled by default", () => {
  assert.equal(defaultConfig().defaults.worktree, true);
});

test("worktree branches are prompt-derived and namespaced", () => {
  const branch = worktreeBranch("Fix the login redirect!", "codex");
  assert.match(branch, /^composer\/fix-the-login-redi-\d{6}$/);
});

test("createWorktree uses the selected Herdr workspace or directory", () => {
  const { bin, log } = installFakeHerdr();
  process.env.HERDR_BIN_PATH = bin;
  process.env.FAKE_HERDR_LOG = log;

  const created = createWorktree(
    { workspace_id: "w1", cwd: "/repo" },
    { branch: "composer/test", label: "Test" },
  );

  assert.equal(created.workspace_id, "wt-1");
  assert.equal(created.cwd, "/tmp/checkout");
  assert.deepEqual(callsFrom(log)[0], [
    "worktree",
    "create",
    "--workspace",
    "w1",
    "--branch",
    "composer/test",
    "--label",
    "Test",
    "--focus",
    "--json",
  ]);

  writeFileSync(log, "");
  createWorktree(
    { kind: "path", cwd: "/repo/from-picker" },
    { branch: "composer/path-test" },
  );
  assert.deepEqual(callsFrom(log)[0], [
    "worktree",
    "create",
    "--cwd",
    "/repo/from-picker",
    "--branch",
    "composer/path-test",
    "--focus",
    "--json",
  ]);
});

test("a folder-trust dialog is recognised, a live prompt box is not", () => {
  assert.equal(looksLikeStartupDialog(TRUST_DIALOG_SCREEN), true);
  assert.equal(looksLikeStartupDialog(READY_SCREEN), false);
  assert.equal(looksLikeStartupDialog(""), false);
  assert.equal(
    looksLikeStartupDialog(
      "❯ 1. Yes, allow Codex to work in this folder without asking for approval\n" +
        "  2. No, ask me to approve edits and commands\n",
    ),
    true,
  );
});

test("readiness waits while a dialog is up and gives up after the timeout", async () => {
  useFakeHerdr();
  process.env.FAKE_HERDR_SCREEN = TRUST_DIALOG_SCREEN;

  const blocked = await waitForPromptReady("w1:p1", {
    timeoutMs: 250,
    pollMs: 50,
  });
  assert.deepEqual(blocked, { ready: false, waited: true, reason: "dialog" });

  process.env.FAKE_HERDR_SCREEN = READY_SCREEN;
  const ready = await waitForPromptReady("w1:p1", {
    timeoutMs: 250,
    pollMs: 50,
  });
  assert.equal(ready.ready, true);
});

test("a prompt is never typed into a startup dialog", async () => {
  const { log } = useFakeHerdr();
  process.env.FAKE_HERDR_SCREEN = TRUST_DIALOG_SCREEN;

  const result = await launchSelection({
    space: { kind: "workspace", workspace_id: "w1", cwd: "/repo" },
    harness: "claude",
    model: "opus",
    effort: "medium",
    prompt: "Fix login",
    worktree: false,
    promptReadyTimeoutMs: 250,
    promptPollMs: 50,
  });

  assert.equal(result.prompt_sent, false);
  assert.equal(result.prompt_skipped, "dialog");
  const calls = callsFrom(log);
  assert.ok(!calls.some((args) => args[0] === "agent" && args[1] === "prompt"));
  // The pane is focused so the dialog can be answered.
  assert.ok(calls.some((args) => args[0] === "agent" && args[1] === "focus"));
});

test("a typed-but-unsubmitted prompt gets one Enter nudge", async () => {
  const { log } = useFakeHerdr();
  process.env.FAKE_HERDR_STATUS = "idle";

  const result = await confirmSubmitted("w1:p1", {
    timeoutMs: 100,
    pollMs: 50,
  });

  assert.equal(result.nudged, true);
  const keys = callsFrom(log).filter(
    (args) => args[0] === "agent" && args[1] === "send-keys",
  );
  assert.deepEqual(keys, [["agent", "send-keys", "w1:p1", "enter"]]);

  writeFileSync(log, "");
  process.env.FAKE_HERDR_STATUS = "working";
  const working = await confirmSubmitted("w1:p1", {
    timeoutMs: 500,
    pollMs: 50,
  });
  assert.deepEqual(working, { submitted: true, nudged: false });
  assert.equal(
    callsFrom(log).filter((args) => args[1] === "send-keys").length,
    0,
  );
});

test("agent start retries while the pane shell is still coming up", async () => {
  const { log } = useFakeHerdr();
  process.env.FAKE_HERDR_BUSY = "2";

  const result = await launchSelection({
    space: { kind: "workspace", workspace_id: "w1", cwd: "/repo" },
    harness: "claude",
    model: "opus",
    effort: "medium",
    prompt: "Fix login",
    worktree: false,
  });

  assert.equal(result.prompt_sent, true);
  const calls = callsFrom(log);
  assert.equal(
    calls.filter((args) => args[0] === "agent" && args[1] === "start").length,
    3,
  );
  // No dialog, so no submit polling and no extra keystrokes.
  assert.equal(result.prompt_nudged, false);
  assert.equal(
    calls.filter((args) => ["get", "send-keys"].includes(args[1])).length,
    0,
  );
});

test("launch uses a worktree when set and the old tab flow when unset", async () => {
  const { bin, log } = installFakeHerdr();
  process.env.HERDR_BIN_PATH = bin;
  process.env.FAKE_HERDR_LOG = log;
  delete process.env.FAKE_HERDR_SCREEN;
  delete process.env.FAKE_HERDR_BUSY;
  const base = {
    space: { kind: "workspace", workspace_id: "w1", cwd: "/repo" },
    harness: "codex",
    model: "gpt-5.4",
    effort: "medium",
    prompt: "Fix login",
  };

  await launchSelection({ ...base, worktree: true });
  let calls = callsFrom(log);
  assert.ok(calls.some((args) => args[0] === "worktree"));
  assert.ok(!calls.some((args) => args[0] === "tab"));
  assert.ok(
    calls.some(
      (args) =>
        args[0] === "agent" &&
        args[1] === "start" &&
        args[args.indexOf("--pane") + 1] === "wt-1:p1",
    ),
  );

  writeFileSync(log, "");
  await launchSelection({ ...base, worktree: false });
  calls = callsFrom(log);
  assert.ok(!calls.some((args) => args[0] === "worktree"));
  assert.ok(calls.some((args) => args[0] === "workspace" && args[1] === "focus"));
  assert.ok(calls.some((args) => args[0] === "tab" && args[1] === "create"));
});
