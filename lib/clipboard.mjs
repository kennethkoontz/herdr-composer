import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Save the clipboard image to a temp PNG and return its path, or null when
 * the clipboard holds no image. macOS only (osascript ships with the OS);
 * other platforms return null.
 */
export function saveClipboardImage() {
  if (process.platform !== "darwin") return null;

  const path = join(tmpdir(), `herdr-composer-paste-${Date.now()}.png`);
  const script = [
    "set png to the clipboard as «class PNGf»",
    `set f to open for access POSIX file "${path}" with write permission`,
    "write png to f",
    "close access f",
  ];

  const result = spawnSync(
    "osascript",
    script.flatMap((line) => ["-e", line]),
    { stdio: ["ignore", "ignore", "ignore"], env: process.env },
  );

  return result.status === 0 ? path : null;
}

/**
 * Read plain text from the system clipboard, or null when empty/unavailable.
 */
export function readClipboardText() {
  if (process.platform === "darwin") {
    const result = spawnSync("pbpaste", [], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
    });
    if (result.status !== 0) return null;
    const text = result.stdout ?? "";
    return text.length ? text : null;
  }

  if (process.platform === "linux") {
    for (const [cmd, args] of [
      ["wl-paste", ["--no-newline"]],
      ["xclip", ["-selection", "clipboard", "-o"]],
      ["xsel", ["--clipboard", "--output"]],
    ]) {
      const result = spawnSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: process.env,
      });
      if (result.status === 0 && result.stdout != null) {
        return result.stdout.length ? result.stdout : null;
      }
    }
  }

  return null;
}

/**
 * Write plain text to the system clipboard. Returns true on success.
 * Also emits OSC 52 so the host terminal can accept the copy over SSH/tmux
 * when the local clipboard tool is unavailable or sandboxed.
 */
export function writeClipboardText(text) {
  const value = String(text ?? "");
  let ok = false;

  if (process.platform === "darwin") {
    const result = spawnSync("pbcopy", [], {
      input: value,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "ignore"],
      env: process.env,
    });
    ok = result.status === 0;
  } else if (process.platform === "linux") {
    for (const [cmd, args] of [
      ["wl-copy", []],
      ["xclip", ["-selection", "clipboard"]],
      ["xsel", ["--clipboard", "--input"]],
    ]) {
      const result = spawnSync(cmd, args, {
        input: value,
        encoding: "utf8",
        stdio: ["pipe", "ignore", "ignore"],
        env: process.env,
      });
      if (result.status === 0) {
        ok = true;
        break;
      }
    }
  }

  // OSC 52 clipboard (base64). Many terminals honor this even when pbcopy
  // is blocked (remote panes). Best-effort; ignore write failures.
  try {
    const b64 = Buffer.from(value, "utf8").toString("base64");
    process.stdout.write(`\x1b]52;c;${b64}\x07`);
    ok = true;
  } catch {
    // ignore
  }

  return ok;
}
