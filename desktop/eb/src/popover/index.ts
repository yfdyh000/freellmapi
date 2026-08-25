// Popover view entrypoint — the Electrobun twin of preload-popover.ts + the
// inline script from renderer/popover.html. Runs in the webview (Electroview)
// and calls the bun-side "freeapi:*" handlers over the RPC socket.
import { Electroview } from "electrobun/view";
import type { DesktopRPCSchema, SnapshotPayload } from "../bun/rpc.js";

const rpc = Electroview.defineRPC<DesktopRPCSchema>({
  handlers: { requests: {} },
});
new Electroview({ rpc });

const $ = (id: string) => document.getElementById(id);
const fmt = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);

// Native-UI strings for the active locale, sent by main in each snapshot.
// Seeded with the English defaults already in the HTML so the very first
// paint (before the first snapshot resolves) is never blank.
let S: Record<string, string> = {};
const setText = (id: string, v: string | undefined) => {
  const el = $(id);
  if (el && v) el.textContent = v;
};

function drawChart(hourly: number[]) {
  const c = $("chart") as HTMLCanvasElement;
  const cssW = c.clientWidth, cssH = 64, dpr = window.devicePixelRatio || 2;
  c.width = cssW * dpr; c.height = cssH * dpr;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  const n = hourly.length, gap = 3;
  const bw = (cssW - gap * (n - 1)) / n;
  const max = Math.max(...hourly, 1);
  const grad = ctx.createLinearGradient(0, 0, 0, cssH);
  grad.addColorStop(0, "rgba(48,209,88,0.95)");
  grad.addColorStop(1, "rgba(52,199,89,0.45)");
  const zeroBar = getComputedStyle(document.body).getPropertyValue("--zero-bar").trim();
  for (let i = 0; i < n; i++) {
    const v = hourly[i];
    const h = v === 0 ? 2 : Math.max(3, (v / max) * (cssH - 6));
    const x = i * (bw + gap), y = cssH - h;
    ctx.fillStyle = v === 0 ? zeroBar : grad;
    ctx.beginPath();
    ctx.roundRect(x, y, bw, h, Math.min(3, bw / 2));
    ctx.fill();
  }
  $("peak")!.textContent = max > 1 ? (S.peak || "peak {n}/h").replace("{n}", String(max)) : "";
}

let loginOn = false;
// Snapshot-carried values so copy can run entirely inside the click gesture
// (execCommand needs the original user activation; it expires across awaits).
let lastPort = "31415";
let apiKey = "";

// The Electroview RPC channel corrupts non-ASCII strings (their UTF-8 bytes
// arrive as U+FFxx "wide" code points in the DOM), so the bun side sends
// non-ASCII strings Base64-encoded with a "B" prefix; decode them back here.
function decodeStrings(plain: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(plain)) {
    if (!value.startsWith("B")) { out[key] = value; continue; }
    try {
      const bytes = Uint8Array.from(atob(value.slice(1)), (c) => c.charCodeAt(0));
      out[key] = new TextDecoder().decode(bytes);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

async function refresh() {
  try {
    const s = await rpc.requestProxy["freeapi:snapshot"]();
    S = decodeStrings(s.strings || {});
    lastPort = String(s.port);
    apiKey = s.apiKey || "";
  document.body.classList.toggle("light", s.theme === "light");
  setText("status-label", S.running);
  setText("l-reqs", S.requestsToday);
  setText("l-tokens", S.tokensToday);
  setText("lastmodel-label", S.lastModel);
  setText("open", S.openDashboard);
  setText("copyurl", S.copyUrl);
  setText("copykey", S.copyKey);
  setText("login-label", S.startAtLogin);
  setText("quit", S.quit);
  setText("ax-ago", S.hoursAgo);
  setText("ax-now", S.now);
  $("addr")!.textContent = "127.0.0.1:" + s.port;
  $("reqs")!.textContent = fmt(s.requests);
  $("tokens")!.textContent = fmt(s.tokens);
  $("rate")!.textContent =
    s.successRate == null ? "" : (S.successSuffix || "{n}% success").replace("{n}", String(s.successRate));
  $("model")!.textContent = s.lastModel;
  $("version")!.textContent = s.version ? "v" + s.version : "";
  loginOn = s.loginItem;
  $("login")!.classList.toggle("on", loginOn);
  drawChart(s.hourly);
  } catch (err) {
    console.error("[popover] snapshot failed:", err);
  }
}

function flash(btn: HTMLElement, label: string) {
  const orig = btn.textContent;
  btn.textContent = label; btn.classList.add("copied");
  setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1100);
}

// Copy from the webview: the native Utils.clipboardWriteText (FFI) writes
// nothing on Windows, and execCommand only works inside the original click
// gesture. So: synchronous execCommand first (gesture intact), then the async
// Clipboard API as fallback.
function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* noop */ }
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copyTextLocal(text: string): Promise<boolean> {
  if (legacyCopy(text)) return true;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // noop
  }
  return false;
}

function onReady() {
  const freeapi = {
    snapshot: () => rpc.requestProxy["freeapi:snapshot"](),
    openDashboard: () => rpc.requestProxy["freeapi:open-dashboard"](),
    setLoginItem: (open: boolean) => {
      void rpc.requestProxy["freeapi:set-login-item"](open);
      // start-at-login is deferred; keep the switch purely visual.
      $("login")!.classList.toggle("on", open);
    },
    quit: () => rpc.requestProxy["freeapi:quit"](),
    onRefresh: (cb: () => void) => rpc.addMessageListener("freeapi:refresh", cb),
  };

  $("open")!.addEventListener("click", () => freeapi.openDashboard());
  $("copyurl")!.addEventListener("click", async (e) => {
    const btn = e.target as HTMLElement;
    const ok = await copyTextLocal(`http://127.0.0.1:${lastPort}/v1`);
    flash(btn, ok ? (S.copied || "Copied ✓") : (S.copyFailed || "Copy failed"));
  });
  $("copykey")!.addEventListener("click", async (e) => {
    const btn = e.target as HTMLElement;
    const ok = await copyTextLocal(apiKey);
    flash(btn, ok ? (S.copied || "Copied ✓") : (S.copyFailed || "Copy failed"));
  });
  $("quit")!.addEventListener("click", () => freeapi.quit());
  $("login")!.addEventListener("click", () => {
    loginOn = !loginOn;
    freeapi.setLoginItem(loginOn);
  });

  freeapi.onRefresh(refresh);
  refresh();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", onReady);
} else {
  onReady();
}