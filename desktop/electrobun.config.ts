// Electrobun 2.x config for the FreeLLMAPI desktop shell (see src/ for the
// Electron twin; all Electrobun-side sources live under eb/). Main process =
// Bun runtime entrypoint eb/src/bun/index.ts (bundles server-host.ts and the
// whole server tree; better-sqlite3 is never statically imported outside
// __tests__, so it stays a lazy runtimeRequire). Kept on Bun (build.mainProcess
// = "bun") for a low-risk bridge from the v1 build; migrating to Cottontail is
// a separate, later change.
import fs from "node:fs";
import path from "node:path";
import type { ElectrobunConfig } from "electrobun";

// Hutch runs the config loader with cwd inside .cottontail-tmp (and
// import.meta.url points at a cached artifact), so neither is a usable
// anchor. Walk up from the temp cwd to find the repo root.
function findRepoRoot(): string {
  let repoRoot = "";
  for (let dir = process.cwd(); dir && dir.length > 3; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "client")) && fs.existsSync(path.join(dir, "desktop"))) {
      repoRoot = dir;
      break;
    }
  }
  return repoRoot;
}

// Single version source: desktop/package.json (same file the Electron build's
// app.getVersion() reads), so eb and Electron builds can never drift. Fail
// loudly instead of falling back to a hard-coded version — a stale version in
// the packaged metadata is worse than a failed build.
function appVersion(): string {
  const repoRoot = findRepoRoot();
  if (!repoRoot) throw new Error("electrobun.config: cannot locate repo root (no client/ + desktop/ sibling dirs)");
  const pkgPath = path.join(repoRoot, "desktop", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || !pkg.version) {
    throw new Error(`electrobun.config: desktop/package.json has no version (${pkgPath})`);
  }
  return pkg.version;
}

// The on-disk data directory is resolved at RUNTIME by eb/src/bun/config.ts
// (FREEAPI_DATA_DIR env → <app-root>/data-dir.txt → default Roaming dir), so
// one build serves every layout and nothing needs to be inlined here.

// Client-dist copy: the dashboard's web build is served from the embedded
// Express server; when a client build exists, mirror it into views/client-dist
// so the packaged app is self-contained. Absent (not built yet) → skipped.
function clientDistCopy(): Record<string, string> {
  // copy keys must stay project-relative because Hutch rejects `..` components.
  const repoRoot = findRepoRoot();
  if (!repoRoot) return {};
  const clientDist = path.resolve(repoRoot, "client/dist");
  if (!fs.existsSync(path.join(clientDist, "index.html"))) return {};

  const projectDir = path.join(repoRoot, "desktop");
  const staged = path.join(projectDir, "client-dist");
  fs.rmSync(staged, { recursive: true, force: true });
  fs.cpSync(clientDist, staged, { recursive: true });

  const copy: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(staged, full).replaceAll(path.sep, "/");
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const relKey = path.relative(projectDir, full).replaceAll(path.sep, "/");
        copy[relKey] = path.posix.join("views/client-dist", rel);
      }
    }
  };
  walk(staged);
  return copy;
}

export default {
  app: {
    name: "FreeLLMAPI",
    identifier: "FreeLLMAPI_Bun",
    // Synced from desktop/package.json so eb/Electron builds share one version.
    version: appVersion(),
  },
  runtime: {
    // The app lives in the tray; closing windows must not quit.
    exitOnLastWindowClosed: false,
  },
  build: {
    // Runtime for this branch: Bun (V8+JSC hybrid, ~550MB lower baseline than
    // Cottontail's ~927MB for the same server code — see plan §11). Bun 1.4.0
    // is both Electrobun 2.0's pinned toolchain and the latest stable Bun.
    // The cottontail block below stays for a quick switch-back.
    mainProcess: "bun",
    cottontail: {
      entrypoint: "eb/src/bun/index.ts",
      // Mirrors build.bun.define: without it the Cottontail bundle inlines
      // NODE_ENV as "development", initDb takes the dev branch, finds no
      // migrations table and process.exit(1)s on first launch (silent crash
      // after ~1GB, no config.json, empty db). "desktop" keeps migrations on
      // the first-boot path. The data directory is resolved at runtime, not
      // here (see eb/src/bun/config.ts).
      define: {
        "process.env.NODE_ENV": '"desktop"',
      },
    },
    // Hutch rejects junctions/symlinks anywhere in the output path chain
    // (UnsafeOutputPath); desktop/build and desktop/artifacts are both
    // junctions to a W: cache dir, so the Electrobun build writes to these
    // separate real directories instead (no W: paths in this file). The env
    // overrides let CI build two variants (isolated / shared data dir) into
    // separate output folders in one workflow without clobbering each other.
    buildFolder: process.env.EB_BUILD_FOLDER ?? "build-eb",
    artifactFolder: process.env.EB_ARTIFACT_FOLDER ?? "artifact-eb",
    bun: {
      entrypoint: "eb/src/bun/index.ts",
      // Main-process bundle: minify shrinks the ~12MB unminified server
      // bundle (faster load, less memory). The installer tarball benefit is
      // small (zstd), but it is free.
      minify: true,
      // bun build inlines process.env.NODE_ENV (the Electrobun dev launcher
      // sets it to "development", which makes server initDb() demand an
      // already-migrated DB and exit). Pin it to a non-development,
      // non-production value — migrations run on first boot, and crypto keeps
      // its auto-generated local key file — mirroring the Electron build's
      // unset NODE_ENV behaviour. The data directory is resolved at runtime,
      // not here (see eb/src/bun/config.ts).
      define: {
        "process.env.NODE_ENV": '"desktop"',
      },
    },
    views: {
      popover: {
        entrypoint: "eb/src/popover/index.ts",
      },
    },
    copy: {
      "eb/src/popover/index.html": "views/popover/index.html",
      "assets/freeapi-tray.ico": "views/freeapi-tray.ico",
      // dashboard web build, when present (flattened into the views tree)
      ...clientDistCopy(),
    },
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;