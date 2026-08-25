// Electrobun (Bun runtime) twin of ../src/config.ts. Electrobun has no
// app.getPath('userData'); the data dir is resolved at RUNTIME below instead of
// Utils.paths.userData (which would resolve <OS-appData>/<identifier>/<channel>
// — e.g. AppData\Local\co.freellmapi.desktop\dev).
//
// Priority (first hit wins), so one build serves every layout:
//   1. $FREEAPI_DATA_DIR (fallback $FREELMMAPI_DATA_DIR) — explicit path
//   2. <app-root>/FreeLLMAPI.ini — `dataDir=` key in the portable package
//   3. default: <roaming app-data>/FreeLLMAPI_Bun
// Relative paths resolve against the app root (the folder holding bin/ in the
// portable package), so a USB-stick "green" copy carries its data with it. An
// absolute path such as %APPDATA%\FreeLLMAPI points the build at the Electron
// shell's data (true sharing), while the default keeps eb data isolated.
//
// FreeLLMAPI.ini example:
//   ; FreeLLMAPI portable settings
//   dataDir = ./portable-data      ; relative to this file's folder
//   # or an absolute path:
//   ; dataDir = %APPDATA%\FreeLLMAPI
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Electron's app.getPath('appData'): Windows %APPDATA% (Roaming), macOS
// ~/Library/Application Support, Linux $XDG_CONFIG_HOME (or ~/.config).
// Electrobun's Utils.paths.appData is LOCALAPPDATA on Windows, so it is NOT
// usable for a build that shares data with the Electron shell.
function appDataRoaming(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

// Portable package root. Electrobun's packaged layout is fixed: the main
// bundle compiles to <appRoot>/Resources/app/bun/ and version.json always
// ships at <appRoot>/Resources/. Climbing from import.meta.dir (the bundle's
// own location) to the first directory whose Resources/version.json exists is
// therefore exact on every OS and independent of the executable's name (a
// global bun.exe also sits in a bin/ dir, so probing the exe dir is not
// enough). Source runs (bun entrypoint directly) never find one and fall back
// to the current working directory.
function appRoot(): string {
  let dir = import.meta.dir;
  for (let depth = 0; depth < 6; depth++) {
    if (fs.existsSync(path.join(dir, "Resources", "version.json"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

// Read `dataDir` from <app-root>/FreeLLMAPI.ini (Windows INI conventions: ';'
// and '#' comments, whitespace-insensitive around '=').
function dataDirFromIni(): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(appRoot(), "FreeLLMAPI.ini"), "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim().toLowerCase() === "datadir") {
      const value = trimmed.slice(eq + 1).trim();
      return value || null;
    }
  }
  return null;
}

function resolveDataDir(raw: string): string {
  return path.isAbsolute(raw) ? raw : path.resolve(appRoot(), raw);
}

export interface DesktopConfig {
  port?: number;
  theme?: "dark" | "light" | "system";
  locale?: string;
  lanAccess?: boolean;
}

export function userDataDir(): string {
  const env = (process.env.FREEAPI_DATA_DIR ?? process.env.FREELMMAPI_DATA_DIR ?? "").trim();
  if (env) return resolveDataDir(env);
  const fromIni = dataDirFromIni();
  if (fromIni) return resolveDataDir(fromIni);
  return path.join(appDataRoaming(), "FreeLLMAPI_Bun");
}

function configPath(): string {
  return path.join(userDataDir(), "config.json");
}

export function loadConfig(): DesktopConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as DesktopConfig;
  } catch {
    return {};
  }
}

export function saveConfig(cfg: DesktopConfig): void {
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.warn("[desktop/eb] could not persist config:", err);
  }
}