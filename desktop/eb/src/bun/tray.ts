// Electrobun twin of ../src/tray.ts. The native layer shows the menu on both
// left and right click (no JS-level left/right distinction available in
// Electrobun); the "Popover" menu item toggles the glass popover. The menu is
// rebuilt whenever a locale change is signalled (refreshTrayLocale), mirroring
// Electron's rebuild-on-right-click behaviour.
import path from "node:path";
import { Tray, Utils } from "electrobun/bun";
import { dt, type NativeLocale } from "../../../src/i18n.ts";
import { togglePopover } from "./popover.js";
import { openDashboard } from "./window.js";
import { logsDir, backupsDir, openFolder } from "./fs-folders.js";

const VIEWS_DIR = path.join(import.meta.dir, "../views");

let tray: Tray | null = null;

function buildMenuItems(
  port: number,
  token: string,
  getLocale: () => NativeLocale,
  getLanAccess: () => boolean,
): Parameters<Tray["setMenu"]>[0] {
  const locale = getLocale();
  const lanOn = getLanAccess();
  return [
    {
      type: "normal",
      label: dt(locale, "runningOn", { addr: `${lanOn ? "0.0.0.0" : "127.0.0.1"}:${port}` }),
      enabled: false,
    },
    { type: "normal", label: dt(locale, "openDashboard"), action: "open-dashboard" },
    { type: "normal", label: "Popover", action: "toggle-popover" },
    { type: "divider" },
    {
      type: "normal",
      label: dt(locale, "lanAccess"),
      action: "toggle-lan-access",
      checked: lanOn,
    },
    { type: "normal", label: dt(locale, "openLogs"), action: "open-logs" },
    { type: "normal", label: dt(locale, "openBackups"), action: "open-backups" },
    { type: "divider" },
    { type: "normal", label: dt(locale, "quitApp"), action: "quit" },
  ];
}

export function buildTray(
  port: number,
  token: string,
  getLocale: () => NativeLocale,
  getLanAccess: () => boolean,
  onToggleLanAccess: () => void,
): Tray {
  tray = new Tray({
    // Windows shows the tooltip from the tray title.
    title: dt(getLocale(), "tooltip"),
    image: path.join(VIEWS_DIR, "freeapi-tray.ico"),
    template: false,
    width: 16,
    height: 16,
  });

  tray.setMenu(buildMenuItems(port, token, getLocale, getLanAccess));

  tray.on("tray-clicked", (event: unknown) => {
    const action = (event as { data?: { action?: string } }).data?.action;
    switch (action) {
      case "toggle-popover":
        togglePopover(tray ?? undefined);
        break;
      case "open-dashboard":
        openDashboard(port, token);
        break;
      case "toggle-lan-access":
        onToggleLanAccess();
        break;
      case "open-logs":
        openFolder(logsDir());
        break;
      case "open-backups":
        openFolder(backupsDir());
        break;
      case "quit":
        tray?.remove();
        Utils.quit();
        break;
    }
  });

  return tray;
}

// Update the static tooltip and rebuild the menu after a locale change.
export function refreshTrayLocale(
  port: number,
  token: string,
  getLocale: () => NativeLocale,
  getLanAccess: () => boolean,
): void {
  if (!tray) return;
  tray.setTitle(dt(getLocale(), "tooltip"));
  tray.setMenu(buildMenuItems(port, token, getLocale, getLanAccess));
}

export function getTray(): Tray | null {
  return tray;
}