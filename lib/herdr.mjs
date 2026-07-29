import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export function herdrBin() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

export function expandHome(path) {
  if (!path) return path;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function parseHerdrOutput(stdout, stderr, status, { allowFail = false } = {}) {
  const out = (stdout || "").trim();
  const err = (stderr || "").trim();

  if (status !== 0 && !allowFail) {
    throw new Error(err || out || `herdr exited ${status}`);
  }

  if (!out) return null;

  try {
    return JSON.parse(out);
  } catch {
    if (allowFail) return { raw: out, stderr: err, status };
    throw new Error(`herdr returned non-JSON:\n${out}`);
  }
}

export function runHerdr(args, { allowFail = false } = {}) {
  const result = spawnSync(herdrBin(), args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  if (result.error) {
    throw new Error(`failed to run herdr: ${result.error.message}`);
  }

  return parseHerdrOutput(result.stdout, result.stderr, result.status, {
    allowFail,
  });
}

/** Non-blocking herdr invoke — use for startup paths that need to stay snappy. */
export function runHerdrAsync(args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(herdrBin(), args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (error) {
      reject(new Error(`failed to run herdr: ${error.message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new Error(`failed to run herdr: ${error.message}`));
    });
    child.on("close", (status) => {
      try {
        resolve(
          parseHerdrOutput(stdout, stderr, status ?? 1, { allowFail }),
        );
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function resultOf(response) {
  if (!response) return null;
  if (response.result) return response.result;
  return response;
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mergeDeep(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) {
    return over === undefined ? base : over;
  }
  if (!isObject(base) || !isObject(over)) {
    return over === undefined ? base : over;
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] = key in base ? mergeDeep(base[key], value) : value;
  }
  return out;
}

export function defaultConfig() {
  return {
    project_roots: ["~/workspace"],
    ignore_dir_names: ["archived", "node_modules", ".git", "worktrees"],
    harnesses: ["pi", "claude", "codex", "grok"],
    defaults: {
      harness: "grok",
      model: {
        pi: "google/gemini-3.1-pro-preview",
        claude: "opus",
        codex: "gpt-5.4",
        grok: "grok-4.5",
      },
      effort: {
        pi: "medium",
        claude: "medium",
        codex: "medium",
        grok: "medium",
      },
      worktree: true,
      create_more: false,
    },
    models: {
      pi: [],
      claude: ["opus", "sonnet", "haiku", "fable"],
      codex: [
        "gpt-5.6-sol",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.3-codex-spark",
      ],
      grok: ["grok-4.5", "grok-4.3", "grok-build-latest"],
    },
    effort: {
      pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      claude: ["low", "medium", "high", "xhigh", "max"],
      codex: ["low", "medium", "high", "xhigh"],
      grok: ["low", "medium", "high", "xhigh"],
    },
  };
}

export function loadConfig(configDir) {
  const defaults = defaultConfig();
  const path = join(configDir || ".", "config.json");
  if (!existsSync(path)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return mergeDeep(defaults, raw);
  } catch (error) {
    console.error(`warning: failed to read ${path}: ${error.message}`);
    return defaults;
  }
}

export function listWorkspaces() {
  const result = resultOf(runHerdr(["workspace", "list"]));
  return result?.workspaces || [];
}

export function listPanes() {
  const result = resultOf(runHerdr(["pane", "list"]));
  return result?.panes || [];
}

export function shortPath(path) {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

function buildWorkspaceChoices(config, workspaces, panes) {
  const cwdByWorkspace = new Map();

  for (const pane of panes) {
    const cwd = pane.foreground_cwd || pane.cwd;
    if (!pane.workspace_id || !cwd) continue;
    if (!cwdByWorkspace.has(pane.workspace_id)) {
      cwdByWorkspace.set(pane.workspace_id, cwd);
    }
  }

  const choices = [];
  const seenPaths = new Set();

  for (const ws of workspaces) {
    const cwd = cwdByWorkspace.get(ws.workspace_id) || null;
    choices.push({
      kind: "workspace",
      id: `ws:${ws.workspace_id}`,
      label: cwd ? `${ws.label}  ${shortPath(cwd)}` : ws.label,
      workspace_id: ws.workspace_id,
      cwd,
      focused: !!ws.focused,
    });
    if (cwd) seenPaths.add(resolve(cwd));
  }

  for (const root of config.project_roots || []) {
    const expanded = expandHome(root);
    if (!existsSync(expanded)) continue;

    let entries = [];
    try {
      entries = readdirSync(expanded, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if ((config.ignore_dir_names || []).includes(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;

      const full = resolve(join(expanded, entry.name));
      if (seenPaths.has(full)) continue;

      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }

      seenPaths.add(full);
      choices.push({
        kind: "path",
        id: `path:${full}`,
        label: `${entry.name}  ${shortPath(full)}`,
        workspace_id: null,
        cwd: full,
        focused: false,
      });
    }
  }

  choices.sort((a, b) => {
    if (a.focused !== b.focused) return a.focused ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  return choices;
}

export function workspaceChoices(config) {
  return buildWorkspaceChoices(config, listWorkspaces(), listPanes());
}

/** Parallel workspace+pane fetch so composer open does not wait twice. */
export async function workspaceChoicesAsync(config) {
  const [wsRaw, paneRaw] = await Promise.all([
    runHerdrAsync(["workspace", "list"]),
    runHerdrAsync(["pane", "list"]),
  ]);
  const workspaces = resultOf(wsRaw)?.workspaces || [];
  const panes = resultOf(paneRaw)?.panes || [];
  return buildWorkspaceChoices(config, workspaces, panes);
}

// Discovery is expensive (spawn). Cache for the process lifetime so pickers
// and harness switches stay instant after the first load / warm.
let piModelsCache = null;
let grokModelsCache = null;
const modelsForCache = new Map();
const effortForCache = new Map();

function parsePiModels(stdout) {
  const models = [];
  for (const line of (stdout || "").split(/\r?\n/).slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const [provider, model] = parts;
    if (provider === "provider" || model === "model") continue;
    models.push(`${provider}/${model}`);
  }
  return models;
}

function parseGrokModels(stdout) {
  const models = [];
  for (const line of (stdout || "").split(/\r?\n/)) {
    const match = line.trim().match(/^\*\s+(\S+)/);
    if (match) models.push(match[1]);
  }
  return models;
}

function spawnStdout(command, args) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch {
      finish({ status: 1, stdout: "" });
      return;
    }

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => finish({ status: 1, stdout: "" }));
    child.on("close", (status) => finish({ status: status ?? 1, stdout }));
  });
}

export function listPiModels() {
  if (piModelsCache) return piModelsCache;
  const result = spawnSync("pi", ["--list-models"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  piModelsCache = result.status === 0 ? parsePiModels(result.stdout) : [];
  return piModelsCache;
}

export function listGrokModels() {
  if (grokModelsCache) return grokModelsCache;
  const result = spawnSync("grok", ["models"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  grokModelsCache = result.status === 0 ? parseGrokModels(result.stdout) : [];
  return grokModelsCache;
}

async function listPiModelsAsync() {
  if (piModelsCache) return piModelsCache;
  const result = await spawnStdout("pi", ["--list-models"]);
  piModelsCache = result.status === 0 ? parsePiModels(result.stdout) : [];
  return piModelsCache;
}

async function listGrokModelsAsync() {
  if (grokModelsCache) return grokModelsCache;
  const result = await spawnStdout("grok", ["models"]);
  grokModelsCache = result.status === 0 ? parseGrokModels(result.stdout) : [];
  return grokModelsCache;
}

function mergeModels(configured, discovered, fallback) {
  const merged = [...configured];
  for (const model of discovered) {
    if (!merged.includes(model)) merged.push(model);
  }
  return merged.length ? merged : [fallback];
}

/**
 * Model list for a harness. Never spawns CLIs — uses discovery caches filled
 * by warmModelCaches / listPiModels / listGrokModels. Until discovery is
 * ready, returns configured models (and a fallback) so the UI never blocks.
 */
export function modelsFor(config, harness) {
  if (modelsForCache.has(harness)) return modelsForCache.get(harness);

  const configured = config.models?.[harness] || [];
  if (harness === "pi") {
    if (piModelsCache === null) {
      return mergeModels(configured, [], "google/gemini-3.1-pro-preview");
    }
    const result = mergeModels(
      configured,
      piModelsCache,
      "google/gemini-3.1-pro-preview",
    );
    modelsForCache.set(harness, result);
    return result;
  }
  if (harness === "grok") {
    if (grokModelsCache === null) {
      return mergeModels(configured, [], "grok-4.5");
    }
    const result = mergeModels(configured, grokModelsCache, "grok-4.5");
    modelsForCache.set(harness, result);
    return result;
  }

  const result = configured.length ? configured : [harness];
  modelsForCache.set(harness, result);
  return result;
}

export function effortFor(config, harness) {
  if (effortForCache.has(harness)) return effortForCache.get(harness);
  const result = config.effort?.[harness] || ["low", "medium", "high"];
  effortForCache.set(harness, result);
  return result;
}

/**
 * Background-friendly model discovery. Safe to fire-and-forget at launch so
 * the form paints immediately; pickers pick up the full list once ready.
 */
export async function warmModelCaches(config, harnesses = []) {
  const set = new Set(harnesses);
  const tasks = [];
  if (set.has("pi")) tasks.push(listPiModelsAsync());
  if (set.has("grok")) tasks.push(listGrokModelsAsync());
  await Promise.all(tasks);
  // Drop incomplete entries so the next modelsFor rebuild includes discovery.
  for (const harness of harnesses) {
    modelsForCache.delete(harness);
    modelsFor(config, harness);
    effortFor(config, harness);
  }
}

/** Defaults only — never triggers model discovery spawns. */
export function defaultModel(config, harness) {
  return (
    config.defaults?.model?.[harness] ||
    config.models?.[harness]?.[0] ||
    (harness === "pi"
      ? "google/gemini-3.1-pro-preview"
      : harness === "grok"
        ? "grok-4.5"
        : harness)
  );
}

export function defaultEffort(config, harness) {
  return config.defaults?.effort?.[harness] || effortFor(config, harness)[0];
}

export function slugifyName(text, fallback = "agent") {
  const base = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 18);
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  return `${base || fallback}-${stamp}`.replace(/-+/g, "-").slice(0, 32);
}

export function worktreeBranch(prompt, fallback = "agent") {
  return `composer/${slugifyName(prompt, fallback)}`;
}

export function listAgents() {
  const result = resultOf(runHerdr(["agent", "list"], { allowFail: true }));
  return result?.agents || [];
}

/**
 * Name passed to `agent start` (must be unique).
 * Prefer the bare harness id (`claude`, `pi`) so the sidebar never flashes a
 * suffix — display is the same before/after name clear when name === kind.
 * Only fall back to `claude-2`, `claude-3`, … when the bare name is taken.
 */
export function allocateStartName(harness) {
  const kind =
    String(harness || "agent")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 16) || "agent";

  const used = new Set();
  for (const agent of listAgents()) {
    if (typeof agent?.name === "string" && agent.name) {
      used.add(agent.name);
    }
  }

  if (!used.has(kind)) return kind;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${kind}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${kind}-${Date.now().toString(36).slice(-4)}`.slice(0, 32);
}

export function buildAgentArgs(harness, model, effort) {
  const args = [];
  if (harness === "pi") {
    if (model) args.push("--model", model);
    if (effort) args.push("--thinking", effort);
    return args;
  }
  if (harness === "claude") {
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    return args;
  }
  if (harness === "codex") {
    if (model) args.push("--model", model);
    return args;
  }
  if (harness === "grok") {
    if (model) args.push("--model", model);
    if (effort) args.push("--reasoning-effort", effort);
    return args;
  }
  if (model) args.push("--model", model);
  return args;
}

export function ensureWorkspace(choice) {
  if (choice.kind === "workspace" && choice.workspace_id) {
    runHerdr(["workspace", "focus", choice.workspace_id]);
    return {
      workspace_id: choice.workspace_id,
      cwd: choice.cwd,
      created: false,
    };
  }

  const cwd = choice.cwd;
  if (!cwd) throw new Error("selected space has no path");

  const label = basename(cwd);
  const result = resultOf(
    runHerdr([
      "workspace",
      "create",
      "--cwd",
      cwd,
      "--label",
      label,
      "--focus",
    ]),
  );

  return {
    workspace_id: result.workspace.workspace_id,
    cwd,
    created: true,
    root_pane: result.root_pane,
    tab: result.tab,
  };
}

/**
 * Create a Git worktree from the selected space and open it as a new Herdr
 * workspace. Herdr chooses the checkout directory from its worktrees config.
 */
export function createWorktree(choice, { branch, label } = {}) {
  if (!choice) throw new Error("selected space is required for a worktree");

  const args = ["worktree", "create"];
  if (choice.workspace_id) {
    args.push("--workspace", choice.workspace_id);
  } else if (choice.cwd) {
    args.push("--cwd", choice.cwd);
  } else {
    throw new Error("selected space has no workspace or path");
  }

  if (branch) args.push("--branch", branch);
  if (label) args.push("--label", label);
  args.push("--focus", "--json");

  const result = resultOf(runHerdr(args));
  return {
    workspace_id: result.workspace.workspace_id,
    cwd:
      result.worktree?.path ||
      result.workspace?.worktree?.checkout_path ||
      result.root_pane?.cwd ||
      null,
    created: true,
    root_pane: result.root_pane,
    tab: result.tab,
    worktree: result.worktree,
  };
}

export function createLaunchTab({ workspaceId, cwd, label }) {
  const args = ["tab", "create", "--focus"];
  if (workspaceId) args.push("--workspace", workspaceId);
  if (cwd) args.push("--cwd", cwd);
  if (label) args.push("--label", label);

  const result = resultOf(runHerdr(args));
  return {
    tab_id: result.tab.tab_id,
    pane_id: result.root_pane.pane_id,
  };
}

export function startAgent({ name, kind, paneId, agentArgs }) {
  const args = [
    "agent",
    "start",
    name,
    "--kind",
    kind,
    "--pane",
    paneId,
    "--timeout",
    "60000",
  ];
  if (agentArgs?.length) args.push("--", ...agentArgs);
  return resultOf(runHerdr(args));
}

export function promptAgent(target, text) {
  if (!text?.trim()) return null;
  return resultOf(runHerdr(["agent", "prompt", target, text]));
}

export function focusAgent(target) {
  return runHerdr(["agent", "focus", target], { allowFail: true });
}

/** Drop custom label so the sidebar `agent` token shows harness kind (pi/claude/…). */
export function clearAgentName(target) {
  return runHerdr(["agent", "rename", target, "--clear"], { allowFail: true });
}

/**
 * Dismiss the active Herdr session popup (plugin popup panes). Best-effort.
 * Resolves once the RPC bytes are written (does not wait for a server reply).
 */
export function closePopup() {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.destroy();
      } catch {
        // ignore
      }
      resolve(ok);
    };

    const client = net.createConnection(socketPath);
    const payload =
      JSON.stringify({
        id: "quick-launch:popup-close",
        method: "popup.close",
        params: {},
      }) + "\n";

    // Keep the wait tiny — callers that want instant exit should not await.
    const timer = setTimeout(() => finish(false), 40);

    client.once("connect", () => {
      // Write and finish immediately; no need to wait for drain on a tiny payload.
      try {
        client.write(payload);
      } catch {
        finish(false);
        return;
      }
      finish(true);
    });
    client.once("error", () => finish(false));
  });
}

