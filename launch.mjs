#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  closePopup,
  defaultEffort,
  defaultModel,
  effortFor,
  loadConfig,
  modelsFor,
  workspaceChoices,
} from "./lib/herdr.mjs";
import { printLine, runComposer } from "./lib/tui.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR || "";
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || "";

async function main() {
  const config = loadConfig(configDir);
  let spaces = workspaceChoices(config);
  if (!spaces.length) {
    printLine("No spaces found. Add project_roots in plugin config.json");
    await waitEnter();
    await closePopupAndExit(1);
  }

  const harnesses = (config.harnesses || ["pi"]).filter(Boolean);
  let last = {
    spaceId: spaces.find((s) => s.focused)?.id || spaces[0].id,
    harness: config.defaults?.harness || harnesses[0],
    model: "",
    effort: "",
    prompt: "",
    createMore: !!config.defaults?.create_more,
    ...readLastState(stateDir),
  };

  if (!spaces.some((s) => s.id === last.spaceId)) {
    last.spaceId = spaces[0].id;
  }
  if (!harnesses.includes(last.harness)) {
    last.harness = harnesses[0];
  }
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
      await closePopupAndExit(0);
    }

    last = {
      spaceId: selection.space.id,
      harness: selection.harness,
      model: selection.model,
      effort: selection.effort,
      prompt: selection.createMore ? selection.prompt : "",
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
      spaces = workspaceChoices(config);
      // Brief beat so the new workspace/tab shows up in the next pick list.
      await sleep(200);
      continue;
    }

    await closePopupAndExit(0);
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

async function closePopupAndExit(code = 0) {
  try {
    await closePopup();
  } catch {
    // ignore
  }
  process.exit(code);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

main().catch(async (error) => {
  console.error(error?.stack || error);
  try {
    await closePopup();
  } catch {
    // ignore
  }
  process.exit(1);
});
