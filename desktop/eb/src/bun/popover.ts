// Electrobun twin of ../src/popover.ts. No vibrancy/acrylic equivalent in
// Electrobun 1.18 BrowserWindow (deferred); the panel keeps its solid CSS
// gradient background. Created once, then shown/hidden; hides on blur.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { BrowserWindow, BrowserView, Tray } from "electrobun/bun";
import type { DesktopRPCSchema } from "./rpc.js";

const WIDTH = 316;
const HEIGHT = 348;

// Load the popover through the views:// scheme (Electrobun injects the
// Electroview RPC bridge / preload only for views:// pages — a file:// URL
// renders the HTML but never connects to the bun side).
const POPOVER_URL = "views://popover/index.html";

// FFI for cursor position and working area: tray.getBounds() returns (0,0)
// in Electrobun, so we use GetCursorPos at the moment the user clicks the
// tray menu item, and SystemParametersInfoW to get the taskbar height.
const SPI_GETWORKAREA = 0x0030;
const user32 = dlopen("user32.dll", {
  GetCursorPos: { args: [FFIType.ptr], returns: FFIType.bool },
  SystemParametersInfoW: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
});

type PopoverRPC = ReturnType<typeof BrowserView.defineRPC<DesktopRPCSchema>>;

let popover: BrowserWindow | null = null;
let visible = false;
let blurTimer: ReturnType<typeof setTimeout> | null = null;
let rpc: PopoverRPC | null = null;

// setPopoverRPC injects the bun-side RPC instance (built in index.ts with the
// eight freeapi handlers) so the popover's Electroview can call them.
export function setPopoverRPC(instance: PopoverRPC): void {
  rpc = instance;
}

export function getPopoverWindow(): BrowserWindow | null {
  return popover;
}

function cursorPos(): { x: number; y: number } {
  const buf = Buffer.alloc(8);
  if (user32.symbols.GetCursorPos(buf)) {
    return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) };
  }
  return { x: 0, y: 0 };
}

/** Bottom edge of the working area (screen minus taskbar). */
function workingAreaBottom(): number {
  const rect = Buffer.alloc(16); // RECT: left, top, right, bottom
  if (user32.symbols.SystemParametersInfoW(SPI_GETWORKAREA, 0, rect, 0)) {
    return rect.readInt32LE(12);
  }
  // Fallback: assume 1080p screen.
  return 1080;
}

function createPopover(): BrowserWindow {
  const win = new BrowserWindow({
    title: "FreeLLMAPI",
    frame: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    url: POPOVER_URL,
    // views:// pages get Electrobun's builtin view preload (Electroview RPC
    // bridge globals) injected automatically — passing a second preload here
    // caused double-injection and flaky rendering. Do not add one.
    hidden: true,
    activate: true,
    transparent: false,
    passthrough: false,
    titleBarStyle: "hidden",
    rpc: rpc ?? undefined,
  });

  win.setAlwaysOnTop(true);
  win.setVisibleOnAllWorkspaces(true);
  win.on("blur", () => {
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (visible && popover) {
        visible = false;
        popover.hide();
      }
      blurTimer = null;
    }, 120);
  });
  win.on("close", () => {
    popover = null;
  });

  return win;
}

export function togglePopover(tray?: Tray): void {
  if (!popover) popover = createPopover();

  if (visible) {
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = null;
    visible = false;
    popover.hide();
    return;
  }

  // Use cursor position (near tray icon) instead of tray.getBounds() which
  // returns (0,0) in Electrobun. Vertical position is anchored to the
  // working-area bottom (taskbar top) so the panel always floats just above
  // the taskbar regardless of screen resolution.
  const pos = cursorPos();
  const waBottom = workingAreaBottom();
  popover.show();
  popover.activate();
  popover.setPosition(
    Math.round(pos.x - WIDTH / 2),
    Math.round(waBottom - HEIGHT - 6),
  );
  visible = true;
}