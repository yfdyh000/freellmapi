// Electrobun twin of ../src/window.ts. The dashboard loads straight from the
// embedded Express server (http://127.0.0.1:<port>), exactly like the
// Electron build. Token seeding / desktop-shell flags move into a custom
// preload string (Electrobun has no additionalArguments; native code injects
// the preload as a document-start script).
import { BrowserWindow } from "electrobun/bun";

let dashboardWindow: BrowserWindow | null = null;

export function getDashboardWindow(): BrowserWindow | null {
  return dashboardWindow;
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
}