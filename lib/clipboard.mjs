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
