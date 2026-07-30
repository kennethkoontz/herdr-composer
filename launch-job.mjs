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
    log(
      `ok ${result.name} ${result.pane_id}` +
        (result.prompt_skipped ? ` prompt_skipped=${result.prompt_skipped}` : "") +
        (result.prompt_nudged ? " prompt_nudged=1" : "") +
        (result.prompt_stalled ? " prompt_stalled=1" : ""),
    );
    if (result.prompt_skipped) {
      await notify(
        "Composer prompt not sent",
        result.prompt_skipped === "dialog"
          ? `${result.name} is still waiting on a startup dialog (folder trust?). Answer it, then paste the prompt.`
          : `${result.name} stayed blocked, so the prompt was not submitted.`,
      );
    }
  } catch (error) {
    log(`error ${error?.stack || error}`);
    await notify(
      "Quick Launch failed",
      String(error?.message || error).slice(0, 200),
    );
    process.exitCode = 1;
  }
}

/** Best-effort desktop notification through herdr. */
async function notify(title, body) {
  try {
    const { runHerdr } = await import("./lib/herdr.mjs");
    runHerdr(["notification", "show", title, "--body", body], {
      allowFail: true,
    });
  } catch {
    // ignore
  }
}

main();
