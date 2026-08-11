// Builds the Node sidecar for the Tauri shell as a single self-contained
// executable (SEA), plus the native-module resource tree that must sit next
// to it. P0-verified on Windows / Node 24.19.0.
//
// Steps:
//   1. esbuild-bundle desktop/src/sidecar.ts → build/sidecar.cjs (CJS: Node 24
//      SEA only supports a CommonJS injected main; import.meta.url is shimmed
//      to __filename via banner+define so createRequire resolves better-sqlite3
//      from the node_modules placed next to the exe).
//   2. node --experimental-sea-config → preparation blob.
//   3. copy node.exe + postject-inject the blob → <name>-<triple>.exe.
//   4. copy node_modules (transitive deps of better-sqlite3) beside the exe.
//
// UPX is RELEASE-ONLY: compression costs time on slow machines and buys
// nothing in dev (installed footprint only matters for published builds).
// Pass --upx-level best|1|7… to enable (CI/release uses `best`).
//
// Output: <outDir>/<name>-<targetTriple>.exe + <outDir>/node_modules/...
// Usage:  node scripts/build-sidecar-sea.mjs [--upx-level best] [--out <dir>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const desktopDir = path.resolve(repoRoot, 'desktop');

const args = process.argv.slice(2);
const upxLevel = args[args.indexOf('--upx-level') + 1];
const outDir = path.resolve(
  args[args.indexOf('--out') + 1] ?? path.join(desktopDir, 'sea-test'),
);
const name = 'freellmapi-sidecar';
const targetTriple = execFileSync('rustc', ['--print', 'host-tuple']).toString().trim();
const exeName = `${name}-${targetTriple}.exe`;
const exePath = path.join(outDir, exeName);

function run(cmd, cmdArgs) {
  // On Windows, npm-shipped CLIs (npx, postject) are .cmd shims which need a
  // shell to execute; plain spawn of the bare name fails ENOENT/EINVAL.
  const isCmdShim = process.platform === 'win32' && cmd === 'npx';
  console.log(`> ${cmd} ${cmdArgs.join(' ')}`);
  return execFileSync(isCmdShim ? 'npx.cmd' : cmd, cmdArgs, {
    stdio: 'inherit',
    shell: isCmdShim,
  });
}

// 1. bundle (esbuild)
run(process.execPath, [path.join(desktopDir, 'scripts', 'bundle-sidecar.mjs')]);

// 2. SEA blob
const blobPath = path.join(outDir, 'sidecar.blob');
const seaConfig = {
  main: path.join(desktopDir, 'build', 'sidecar.cjs'),
  output: blobPath,
  disableExperimentalSEAWarning: true,
};
const seaConfigPath = path.join(outDir, 'sea-config.json');
fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));
run(process.execPath, ['--experimental-sea-config', seaConfigPath]);

// 3. copy node.exe + inject blob
fs.copyFileSync(process.execPath, exePath);
run(
  'npx',
  [
    '--yes',
    'postject',
    exePath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
);

// 4. UPX — release-only (see header). Dev builds skip it entirely.
if (upxLevel) {
  const flags =
    upxLevel === 'best' ? ['--best', '--lzma'] : [`-${upxLevel}`, '--lzma'];
  try {
    run('upx', [...flags, exePath]);
  } catch (err) {
    console.warn('[build-sidecar-sea] upx not available; skipping compression.');
  }
}

// 5. native-module resource tree next to the exe. better-sqlite3 pulls in
// bindings, which pulls in file-uri-to-path — collect the whole transitive
// dep set from the hoisted root node_modules so the SEA's createRequire
// resolution (exe dir → node_modules) never hits MODULE_NOT_FOUND.
function collectPkgs(root, name, out) {
  if (out.has(name)) return out;
  out.add(name);
  const pkgJson = path.join(root, 'node_modules', name, 'package.json');
  if (!fs.existsSync(pkgJson)) return out;
  const deps = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).dependencies ?? {};
  for (const dep of Object.keys(deps)) collectPkgs(root, dep, out);
  return out;
}

const pkgs = collectPkgs(repoRoot, 'better-sqlite3', new Set());
for (const pkg of pkgs) {
  const src = path.join(repoRoot, 'node_modules', pkg);
  const dst = path.join(outDir, 'node_modules', pkg);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
}

const size = fs.statSync(exePath).size;
console.log(`[build-sidecar-sea] ${exeName} = ${(size / 1024 / 1024).toFixed(2)} MB (target ${targetTriple})`);
console.log(`[build-sidecar-sea] resources: ${path.join(outDir, 'node_modules')}`);
