#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultEffort,
  defaultModel,
  effortFor,
  loadConfig,
  modelsFor,
  warmModelCaches,
  workspaceChoicesAsync,
} from "./lib/herdr.mjs";
import { printLine, runComposer } from "./lib/tui.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR || "";
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || "";

async function main() {
  const config = loadConfig(configDir);
  const harnesses = (config.harnesses || ["pi"]).filter(Boolean);

  // Never block the form on model discovery — pickers start with config/defaults
  // and pick up full lists once this finishes.
  void warmModelCaches(config, harnesses).catch(() => {});

  // workspace + pane lists in parallel (was two sequential herdr spawns).
  let spaces = await workspaceChoicesAsync(config);
  if (!spaces.length) {
    printLine("No spaces found. Add project_roots in plugin config.json");
    await waitEnter();
    closeAndExit(1);
  }

  let last = {
    spaceId: spaces.find((s) => s.focused)?.id || spaces[0].id,
    harness: config.defaults?.harness || harnesses[0],
    model: "",
    effort: "",
    prompt: "",
    worktree: config.defaults?.worktree !== false,
    createMore: !!config.defaults?.create_more,
    ...readLastState(stateDir),
  };

  if (!spaces.some((s) => s.id === last.spaceId)) {
    last.spaceId = spaces[0].id;
  }
  if (!harnesses.includes(last.harness)) {
    last.harness = harnesses[0];
  }
  // defaultModel never spawns CLIs.
  if (!last.model) last.model = defaultModel(config, last.harness);
  if (!last.effort) last.effort = defaultEffort(config, last.harness);

  while (true) {
    const selection = await runComposer({
      spaces,
      harnesses,
      getModels: (harness) => modelsFor(config, harness),
      getEffort: (harness) => effortFor(config, harness),
      initial: last,
    });

    if (!selection) {
      closeAndExit(0);
    }

    last = {
      spaceId: selection.space.id,
      harness: selection.harness,
      model: selection.model,
      effort: selection.effort,
      prompt: selection.createMore ? selection.prompt : "",
      worktree: selection.worktree,
      createMore: selection.createMore,
    };
    writeLastState(stateDir, last);

    // Kick off agent start in a detached worker, then dismiss the popup
    // immediately so we don't sit on `herdr agent start --timeout …`.
    try {
      enqueueLaunch(selection);
    } catch (error) {
      printLine(`Error: ${error.message || error}`);
      printLine("Press enter to return to the form…");
      await waitEnter();
      continue;
    }

    if (selection.createMore) {
      spaces = await workspaceChoicesAsync(config);
      continue;
    }

    closeAndExit(0);
  }
}

function enqueueLaunch(selection) {
  const dir = stateDir || join(__dirname, ".state");
  mkdirSync(dir, { recursive: true });
  const jobPath = join(
    dir,
    `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  writeFileSync(jobPath, `${JSON.stringify(selection)}\n`);

  const worker = join(__dirname, "launch-job.mjs");
  const child = spawn(process.execPath, [worker, jobPath], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      QUICK_LAUNCH_LOG: join(dir, "launch.log"),
    },
  });
  child.unref();
}

/**
 * Send popup.close then exit as soon as the write lands (or after a tiny
 * cap). Awaiting a full close round-trip felt like "spin down"; skipping the
 * write entirely left the popup stuck when process.exit killed the socket.
 */
function closeAndExit(code = 0) {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) {
    process.exit(code);
    return;
  }

  let exited = false;
  const exitNow = () => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };

  // Hard cap so a hung socket never stalls dismiss.
  const timer = setTimeout(exitNow, 30);

  try {
    const client = net.createConnection(socketPath);
    const payload =
      JSON.stringify({
        id: "quick-launch:popup-close",
        method: "popup.close",
        params: {},
      }) + "\n";

    client.once("connect", () => {
      try {
        client.write(payload, () => {
          clearTimeout(timer);
          try {
            client.destroy();
          } catch {
            // ignore
          }
          exitNow();
        });
      } catch {
        clearTimeout(timer);
        exitNow();
      }
    });
    client.once("error", () => {
      clearTimeout(timer);
      exitNow();
    });
  } catch {
    clearTimeout(timer);
    exitNow();
  }
}

function readLastState(dir) {
  if (!dir) return {};
  try {
    const path = join(dir, "last.json");
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function writeLastState(dir, state) {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "last.json"), `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // ignore
  }
}

function waitEnter() {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve();
      return;
    }
    const onData = (buf) => {
      if (String(buf).includes("\n") || String(buf).includes("\r")) {
        process.stdin.off("data", onData);
        resolve();
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

main().catch((error) => {
  console.error(error?.stack || error);
  closeAndExit(1);
});
