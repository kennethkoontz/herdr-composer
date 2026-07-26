#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const herdr = process.env.HERDR_BIN_PATH || "herdr";
const pluginId = process.env.HERDR_PLUGIN_ID || "kennethkoontz.herdr-composer";

const result = spawnSync(
  herdr,
  [
    "plugin",
    "pane",
    "open",
    "--plugin",
    pluginId,
    "--entrypoint",
    "composer",
    "--focus",
  ],
  {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  },
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
