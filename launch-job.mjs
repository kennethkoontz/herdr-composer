#!/usr/bin/env node
/**
 * Detached launcher: runs outside the composer popup so Create can dismiss
 * the UI immediately while agent start continues in the background.
 */
import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { launchSelection } from "./lib/launch.mjs";

const jobPath = process.argv[2];
if (!jobPath) {
  console.error("usage: launch-job.mjs <job.json>");
  process.exit(2);
}

function log(line) {
  try {
    const logPath = process.env.QUICK_LAUNCH_LOG;
    if (!logPath) return;
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // ignore
  }
}

async function main() {
  const raw = readFileSync(jobPath, "utf8");
  try {
    unlinkSync(jobPath);
  } catch {
    // ignore
  }

  const selection = JSON.parse(raw);
  log(`start ${selection.harness} ${selection.model || ""}`);
  try {
    const result = await launchSelection(selection);
    log(`ok ${result.name} ${result.pane_id}`);
  } catch (error) {
    log(`error ${error?.stack || error}`);
    // Surface via herdr notification if available.
    try {
      const { runHerdr } = await import("./lib/herdr.mjs");
      runHerdr(
        [
          "notification",
          "show",
          "Quick Launch failed",
          "--body",
          String(error?.message || error).slice(0, 200),
        ],
        { allowFail: true },
      );
    } catch {
      // ignore
    }
    process.exitCode = 1;
  }
}

main();
