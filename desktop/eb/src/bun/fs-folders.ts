// Electrobun twin of ../src/logger.ts's folder helpers: the tray menu can
// reveal the on-disk logs and backup directories. Electrobun's Utils.openPath
// is the shell.openPath equivalent; the directory is created first so the
// reveal works even before anything has been written (mirrors Electron's
// openLogsFolder).
import fs from "node:fs";
import path from "node:path";
import { Utils } from "electrobun/bun";
import { userDataDir } from "./config.js";

export function logsDir(): string {
  return path.join(userDataDir(), "logs");
}

// The server's default backup directory is <db-dir>/backups (the db lives in
// the user data dir), so this is the folder the backup dumps land in.
export function backupsDir(): string {
  return path.join(userDataDir(), "backups");
}

export function openFolder(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    Utils.openPath(dir);
  } catch (err) {
    console.warn("[desktop/eb] could not open folder:", dir, err);
  }
}