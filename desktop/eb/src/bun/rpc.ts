// Shared RPC schema for the Electrobun build of the desktop shell.
// Bun side (main process) handles Schema.bun.requests; the popover view
// (Electroview) calls them via rpc.requestProxy. Schema.webview.messages
// are bun -> webview push messages (popover refresh). Mirrors the eight
// Electron ipcMain channels from ../src/main.ts.
import type { ElectrobunRPCSchema } from "electrobun";

export interface SnapshotPayload {
  port: number;
  requests: number;
  tokens: number;
  lastModel: string;
  successRate: number | null;
  hourly: number[];
  loginItem: boolean;
  version: string;
  theme: "dark" | "light";
  locale: string;
  strings: Record<string, string>;
  // Carried in the snapshot so the popover can copy inside the click gesture
  // without an extra round-trip (gesture expires across awaits).
  apiKey: string;
}

export const DESKTOP_RPC = {
  bun: {
    requests: {
      "freeapi:snapshot": { response: {} as SnapshotPayload },
      "freeapi:open-dashboard": {},
      "freeapi:copy-base-url": {},
      "freeapi:copy-api-key": {},
      "freeapi:set-login-item": { params: {} as boolean },
      "freeapi:quit": {},
      "freeapi:theme-changed": { params: {} as { resolved: string; choice?: string } },
      "freeapi:locale-changed": { params: {} as string },
    },
    messages: {},
  },
  webview: {
    requests: {},
    messages: { "freeapi:refresh": {} },
  },
} satisfies ElectrobunRPCSchema;

export type DesktopRPCSchema = typeof DESKTOP_RPC;