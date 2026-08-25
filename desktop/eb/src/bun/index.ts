// Electrobun (Bun runtime) main process — the twin of ../src/main.ts.
// Lifecycle: the native host boots the Bun process and FFI bridges are ready
// before this module runs, so there is no app.whenReady() equivalent; top-level
// await from here on is the app's startup sequence.
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import Electrobun, { BrowserView, Utils } from "electrobun/bun";
import { startServer, ensureSessionToken, getUnifiedApiKey } from "../../../src/server-host.ts";
import { loadConfig, saveConfig, userDataDir } from "./config.js";
import { logsDir } from "./fs-folders.js";
import { buildTray, refreshTrayLocale, getTray } from "./tray.js";
import { setPopoverRPC, getPopoverWindow, togglePopover } from "./popover.js";
import { acquireSingleInstance } from "./single-instance.js";
import { openDashboard } from "./window.js";
import { todayStats, hourlyRequests, successRateToday } from "./stats.js";
import { normalizeLocale, nativeStrings, type NativeLocale } from "../../../src/i18n.ts";
import type { DesktopRPCSchema, SnapshotPayload } from "./rpc.js";

const DEFAULT_PORT = 31415;
// Stored so toggleLanAccess() can close the server before spawning a
// replacement, releasing the port and preventing a +1 scan.
let httpServer: Server | null = null;
const RESOURCES_DIR = path.join(import.meta.dir, "..", ".."); // .../Resources (packaged) or desktop/eb (source)
const VIEWS_DIR = path.join(import.meta.dir, "..", "views");

// Note: process.env.NODE_ENV is pinned to "production" at build time by
// electrobun.config.ts (build.bun.define) — bun inlines it, so a runtime
// assignment here would be a no-op. That keeps server initDb() on the
// migrations path instead of the "DB already initialised" dev branch.

// version.json ships in Resources/ (packaged); absent when running the source
// entrypoint directly under bun.
function appVersion(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(RESOURCES_DIR, "version.json"), "utf8"));
    return typeof raw.version === "string" ? raw.version : "dev";
  } catch {
    return "dev";
  }
}

const version = appVersion();

await acquireSingleInstance();

const cfg = loadConfig();
// System-language probe, used only as the initial fallback before the dashboard
// mirrors its own locale via RPC. `Intl` is the one locale source available in
// every runtime (Node/Bun/Cottontail) and on Windows returns e.g. zh-CN.
function systemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return "en";
  }
}
let locale: NativeLocale = normalizeLocale(
  (process.env.FREEAPI_LOCALE as string | undefined) ?? cfg.locale ?? systemLocale(),
);
let theme: "dark" | "light" = cfg.theme === "light" ? "light" : "dark";

let resolvedPort = DEFAULT_PORT;
let sessionToken = "";

// Diagnostic tap: every popover RPC lands here as one line, so a "button does
// nothing" report can be resolved by reading the log instead of guessing.
function rpcLog(method: string): void {
  try {
    const dir = logsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "rpc.log"), `${new Date().toISOString()} ${method}\n`);
  } catch {
    // logging must never take the app down
  }
}

// Webview lifecycle marks (emitted by the injected preload): prove whether a
// view's preload bridge actually ran, independent of RPC handler calls.
Electrobun.events.on("dom-ready", (e) => rpcLog(`dom-ready ${e.detail}`));
Electrobun.events.on("did-navigate", (e) => rpcLog(`did-navigate ${e.detail}`));

// The Electroview RPC channel mangles non-ASCII strings (UTF-8 bytes become
// U+FFxx code points on the page), so non-ASCII string values are sent as
// UTF-8 → Base64 with a "B" prefix; the popover decodes them back.
function encodeStrings(plain: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(plain)) {
    out[key] = /[\u0080-\uffff]/.test(value) ? "B" + Buffer.from(value, "utf8").toString("base64") : value;
  }
  return out;
}

// Flip the LAN-access flag and relaunch so the server rebinds (127.0.0.1 →
// 0.0.0.0). Enabling shows a one-time warning: the API becomes reachable by
// anything that can route to this machine, guarded only by the unified key.
// Mirrors toggleLanAccess in ../src/main.ts. Electrobun has no app.relaunch(),
// so the launcher (bin/launcher.exe) is respawned detached and this process
// exits, exactly like the Updater's restart flow.
async function toggleLanAccess(): Promise<void> {
  const current = loadConfig().lanAccess ?? false;
  const enabling = !current;
  if (enabling) {
    const { response } = await Utils.showMessageBox({
      type: "warning",
      buttons: ["Enable LAN access", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: "Allow LAN access",
      message: "Expose FreeLLMAPI to your local network?",
      detail:
        `The server will bind to 0.0.0.0 so other devices (Tailscale, VMs, ` +
        `phones on your Wi-Fi) can reach it at http://<this-machine-ip>:` +
        `${resolvedPort}/v1.\n\nThe API is protected only by your unified ` +
        `API key. Only do this on a network you trust. The app will restart ` +
        `to apply the change.`,
    });
    if (response !== 0) return;
  }
  saveConfig({ ...loadConfig(), lanAccess: enabling });
  // Release the server port so the replacement process binds the same port
  // instead of scanning to 31416.
  httpServer?.close();
  // In the packaged app the launcher is <appRoot>/bin/launcher.exe; in dev
  // mode (bunx electrobun dev) process.execPath is the correct entry point.
  const launcher = (() => {
    let dir = import.meta.dir;
    for (let depth = 0; depth < 6; depth++) {
      const candidate = path.join(dir, "bin", "launcher.exe");
      if (fs.existsSync(candidate)) return candidate;
      dir = path.dirname(dir);
    }
    return process.execPath;
  })();
  try {
    Bun.spawn([launcher], { detached: true, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  } catch (err) {
    console.warn("[desktop/eb] relaunch failed:", err);
  }
  getPopoverWindow()?.close();
  Utils.quit();
}

// The popover (and the future dashboard view) can request these after the
// server is up; the only stateful pieces are resolvedPort/sessionToken/theme.
const rpc = BrowserView.defineRPC<DesktopRPCSchema>({
  handlers: {
    requests: {
      "freeapi:snapshot": (): SnapshotPayload => {
        rpcLog("snapshot");
        const s = todayStats();
        return {
          port: resolvedPort,
          requests: s.requests,
          tokens: s.tokens,
          lastModel: s.lastModel,
          successRate: successRateToday(),
          hourly: hourlyRequests(),
          loginItem: false, // start-at-login deferred
          version,
          theme,
          locale,
          strings: encodeStrings(nativeStrings(locale)),
          apiKey: getUnifiedApiKey(),
        };
      },
      "freeapi:open-dashboard": () => {
        rpcLog("open-dashboard");
        openDashboard(resolvedPort, sessionToken, version);
      },
      "freeapi:copy-base-url": () => {
        rpcLog("copy-base-url");
        Utils.clipboardWriteText(`http://127.0.0.1:${resolvedPort}/v1`);
      },
      "freeapi:copy-api-key": () => {
        rpcLog("copy-api-key");
        Utils.clipboardWriteText(getUnifiedApiKey());
      },
      "freeapi:set-login-item": () => {
        // start-at-login deferred (degraded item)
      },
      "freeapi:quit": () => {
        rpcLog("quit");
        getPopoverWindow()?.close();
        Utils.quit();
      },
      "freeapi:theme-changed": () => {
        // dashboard theme mirroring deferred; theme stays config-driven
      },
      "freeapi:locale-changed": (raw: string) => {
        // Mirror the dashboard's language choice into the tray menu/tooltip and
        // the persisted config, exactly like Electron's ipcMain locale handler.
        const next = normalizeLocale(raw);
        if (next === locale) return;
        locale = next;
        saveConfig({ ...loadConfig(), locale });
        refreshTrayLocale(resolvedPort, sessionToken, () => locale, () => loadConfig().lanAccess ?? false);
        getPopoverWindow()?.webContents?.send("freeapi:refresh");
      },
    },
  },
});
setPopoverRPC(rpc);

const dbPath = path.join(Utils.paths.userData, "freeapi.db");

// clientDist precedence: bundled views copy (Electrobun build) → FREEAPI_REPO
// → repo default (source run).
function resolveClientDist(): string {
  const inViews = path.join(VIEWS_DIR, "client-dist");
  if (fs.existsSync(inViews)) return inViews;
  if (process.env.FREEAPI_REPO) return path.resolve(process.env.FREEAPI_REPO, "client/dist");
  return path.resolve(import.meta.dir, "../../../../client/dist");
}

const clientDist = resolveClientDist();
const host = cfg.lanAccess ? "0.0.0.0" : "127.0.0.1";

process.env.FREEAPI_VERSION = version;

const { server, port } = await startServer({
  dbPath,
  clientDist,
  host,
  preferredPort: cfg.port ?? DEFAULT_PORT,
});
httpServer = server;
resolvedPort = port;
sessionToken = ensureSessionToken();
saveConfig({ ...loadConfig(), port });

const tray = buildTray(port, sessionToken, () => locale, () => loadConfig().lanAccess ?? false, () => void toggleLanAccess());
console.log(
  `[desktop/eb] FreeLLMAPI running on http://${host}:${port}${cfg.lanAccess ? " (LAN access enabled)" : ""}`,
);
console.log(`[desktop/eb] tray + popover ready; userData=${Utils.paths.userData}`);

// Dev-only helper, mirroring Electron's FREEAPI_SHOT: open the popover on
// startup so view/RPC plumbing can be exercised without clicking the tray.
if (process.env.FREEAPI_OPEN_POPOVER === "1") {
  togglePopover(tray);
  // FREEAPI_POPOVER_DEVTOOLS=1 also opens the WebView2 devtools for view
  // debugging (console errors, DOM inspection).
  if (process.env.FREEAPI_POPOVER_DEVTOOLS === "1") {
    getPopoverWindow()?.webview?.openDevTools();
  }
}