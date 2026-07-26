import { spawnSync } from "node:child_process";
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

export function runHerdr(args, { allowFail = false } = {}) {
  const result = spawnSync(herdrBin(), args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  if (result.error) {
    throw new Error(`failed to run herdr: ${result.error.message}`);
  }

  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();

  if (result.status !== 0 && !allowFail) {
    throw new Error(stderr || stdout || `herdr exited ${result.status}`);
  }

  if (!stdout) return null;

  try {
    return JSON.parse(stdout);
  } catch {
    if (allowFail) return { raw: stdout, stderr, status: result.status };
    throw new Error(`herdr returned non-JSON:\n${stdout}`);
  }
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
      create_more: false,
    },
    models: {
      pi: [],
      claude: ["opus", "sonnet", "haiku", "fable"],
      codex: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.3-codex-spark"],
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

export function workspaceChoices(config) {
  const workspaces = listWorkspaces();
  const panes = listPanes();
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

export function listPiModels() {
  const result = spawnSync("pi", ["--list-models"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (result.status !== 0) return [];

  const models = [];
  for (const line of (result.stdout || "").split(/\r?\n/).slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const [provider, model] = parts;
    if (provider === "provider" || model === "model") continue;
    models.push(`${provider}/${model}`);
  }
  return models;
}

export function listGrokModels() {
  const result = spawnSync("grok", ["models"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (result.status !== 0) return [];

  const models = [];
  for (const line of (result.stdout || "").split(/\r?\n/)) {
    const match = line.trim().match(/^\*\s+(\S+)/);
    if (match) models.push(match[1]);
  }
  return models;
}

export function modelsFor(config, harness) {
  const configured = config.models?.[harness] || [];
  if (harness === "pi") {
    const discovered = listPiModels();
    const merged = [...configured];
    for (const model of discovered) {
      if (!merged.includes(model)) merged.push(model);
    }
    return merged.length ? merged : ["google/gemini-3.1-pro-preview"];
  }
  if (harness === "grok") {
    const discovered = listGrokModels();
    const merged = [...configured];
    for (const model of discovered) {
      if (!merged.includes(model)) merged.push(model);
    }
    return merged.length ? merged : ["grok-4.5"];
  }
  return configured.length ? configured : [harness];
}

export function effortFor(config, harness) {
  return config.effort?.[harness] || ["low", "medium", "high"];
}

export function defaultModel(config, harness) {
  return config.defaults?.model?.[harness] || modelsFor(config, harness)[0];
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

    // Only ensure the write reaches the kernel — no need to wait for a reply.
    const timer = setTimeout(() => finish(false), 80);

    client.once("connect", () => {
      client.write(payload, () => finish(true));
    });
    client.once("error", () => finish(false));
  });
}
