// Bundles desktop/src/sidecar.ts into build/sidecar.cjs — the Node sidecar
// for the Tauri shell. Same recipe as bundle-server.mjs: esbuild flattens the
// server and @freellmapi/shared, only better-sqlite3 stays external (native
// module, resolved at runtime via createRequire).
//
// CJS on purpose: Node 24's SEA only supports a CommonJS injected main
// (mainFormat is v25.5+). import.meta.url is shimmed to {} in CJS output, so
// we define it to a banner-computed value derived from __filename — inside a
// SEA, __filename is the executable's own path, which makes createRequire
// walk the node_modules placed next to the exe for better-sqlite3.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.resolve(__dirname, '../src/sidecar.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: path.resolve(__dirname, '../build/sidecar.cjs'),
  external: ['better-sqlite3'],
  banner: {
    js: "var __seaMetaUrl = require('url').pathToFileURL(__filename).href;",
  },
  define: {
    'import.meta.url': '__seaMetaUrl',
  },
  logLevel: 'info',
});
