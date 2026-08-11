// Node sidecar entry for the Tauri shell — the twin of main.ts's server
// bootstrap, minus all Electron. Spawned as an external binary by the Rust
// shell; reports the resolved port on stdout, then serves until killed.
//
// Args: --db <path> --client-dist <path> --host <ip> --port <n>
// Keeps the server-host contract: one bundled copy of the server, db
// singleton inside this bundle. Bundled as CJS (SEA's ESM main has
// top-level-await and loader limits; CJS avoids both).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, ensureSessionToken } from './server-host.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  // Independent data dir (mirrors the bun-branch's FreeLLMAPI_Bun): the Tauri
  // build must not touch the Electron app's real data while it is being
  // debugged/developed. A future migration tool can move it if ever needed.
  const dbPath =
    arg('--db') ??
    path.join(process.env.APPDATA ?? process.cwd(), 'FreeLLMAPI_Tauri', 'freeapi.db');
  const clientDist = arg('--client-dist') ?? path.resolve(__dirname, '../../client/dist');
  const host = arg('--host') ?? '127.0.0.1';
  const preferredPort = Number(arg('--port') ?? '31415');

  const { port } = await startServer({ dbPath, clientDist, host, preferredPort });
  ensureSessionToken();

  console.log(`[sidecar] READY port=${port}`);
}

main().catch((err) => {
  console.error('[sidecar] fatal:', err);
  process.exit(1);
});

