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
import { launchSelection } from "../lib/launch.mjs";

function installFakeHerdr() {
  const dir = mkdtempSync(join(tmpdir(), "herdr-composer-test-"));
  const bin = join(dir, "herdr");
  const log = join(dir, "calls.jsonl");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(args) + "\\n");
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
  return { bin, log };
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

test("launch uses a worktree when set and the old tab flow when unset", async () => {
  const { bin, log } = installFakeHerdr();
  process.env.HERDR_BIN_PATH = bin;
  process.env.FAKE_HERDR_LOG = log;
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
