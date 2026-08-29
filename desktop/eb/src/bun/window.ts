// Electrobun twin of ../src/window.ts. The dashboard loads straight from the
// embedded Express server (http://127.0.0.1:<port>), exactly like the
// Electron build. Token seeding / desktop-shell flags move into a custom
// preload string (Electrobun has no additionalArguments; native code injects
// the preload as a document-start script).
import fs from "node:fs";
import path from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { BrowserWindow } from "electrobun/bun";

let dashboardWindow: BrowserWindow | null = null;

export function getDashboardWindow(): BrowserWindow | null {
  return dashboardWindow;
}

// The packaged app ships the app icon at <appRoot>/Resources/app.ico (Hutch
// converts the build.win.icon PNG to ICO at build time). Source/dev runs never
// have it, so we silently skip — the window keeps the exe default there.
function appIconPath(): string | null {
  let dir = import.meta.dir;
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, "Resources", "app.ico");
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

const WM_SETICON = 0x0080;
const ICON_SMALL = 0;
const ICON_BIG = 1;
const IMAGE_ICON = 1;
const LR_LOADFROMFILE = 0x10;
const LR_DEFAULTSIZE = 0x40;

const user32 = dlopen("user32.dll", {
  IsWindow: { args: [FFIType.ptr], returns: FFIType.bool },
  LoadImageW: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u32],
    returns: FFIType.ptr,
  },
  SendMessageW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.ptr },
});

function wide(str: string): Uint8Array {
  return Buffer.from(str + "\0", "utf16le");
}

// Electrobun's BrowserWindow has no icon option and libNativeWrapper's
// setWindowIcon export is a stub, so the title-bar icon stays blank. Set it
// directly via Win32: load the app.ico into an HICON and send WM_SETICON
// (small + big) to the window's HWND. Windows-only; harmless no-op elsewhere.
function applyWindowIcon(win: BrowserWindow): void {
  if (process.platform !== "win32") return;
  const ico = appIconPath();
  if (!ico) return;
  // The native HWND exists right after the synchronous createWindow; the delay
  // just keeps us clear of the initial paint.
  setTimeout(() => {
    try {
      const hwnd = win.ptr as unknown as bigint;
      if (!user32.symbols.IsWindow(hwnd)) return;

      const hIcon = user32.symbols.LoadImageW(
        null,
        ptr(wide(ico)),
        IMAGE_ICON,
        0,
        0,
        LR_LOADFROMFILE | LR_DEFAULTSIZE,
      );
      if (!hIcon) return;

      user32.symbols.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, hIcon);
      user32.symbols.SendMessageW(hwnd, WM_SETICON, ICON_BIG, hIcon);
    } catch (err) {
      console.warn("[desktop/eb] setWindowIcon:", err);
    }
  }, 150);
}

export function openDashboard(port: number, token: string, version: string): void {
  if (dashboardWindow) {
    dashboardWindow.show();
    dashboardWindow.activate();
    return;
  }

  // Injected before any page script runs: no login flash, no reload.
  const preload = `
try {
  localStorage.setItem('freellmapi_dashboard_token', ${JSON.stringify(token)});
} catch (e) {}
window.__FREEAPI_DESKTOP__ = true;
window.__FREEAPI_VERSION__ = ${JSON.stringify(version)};
var __d = document.documentElement;
if (__d) __d.classList.add('desktop');
else document.addEventListener('DOMContentLoaded', function () { document.documentElement.classList.add('desktop'); });
`;

  dashboardWindow = new BrowserWindow({
    title: "FreeLLMAPI",
    frame: { x: 0, y: 0, width: 1200, height: 800 },
    url: `http://127.0.0.1:${port}`,
    preload,
    hidden: false,
    titleBarStyle: "default",
  });

  dashboardWindow.on("close", () => {
    dashboardWindow = null;
  });

  applyWindowIcon(dashboardWindow);
}