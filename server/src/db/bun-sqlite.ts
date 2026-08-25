import { createRequire } from 'node:module';
import type { Db, DbFactory, DbStatement } from './types.js';

const runtimeRequire = createRequire(import.meta.url);

type BunRunResult = { changes: number | bigint; lastInsertRowid: number | bigint };
type BunStatement = {
  run(...params: unknown[]): BunRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

type BunDatabase = {
  prepare(sql: string): BunStatement;
  query(sql: string): BunStatement;
  run(sql: string, ...params: unknown[]): unknown;
  close(): void;
};

type BunSqliteModule = {
  Database: new (path: string, opts?: { create?: boolean }) => BunDatabase;
};

// Lazy-loaded: `bun:sqlite` is a build-in only in Bun/Cottontail runtimes.
// A top-level static import crashes Node, so it is resolved here on first use —
// require('bun:sqlite') works under Bun the same way node:sqlite does under
// Node (verified on Bun 1.3). This module itself is safe to import anywhere.
function loadBunSqlite(): BunSqliteModule {
  try {
    return runtimeRequire('bun:sqlite') as BunSqliteModule;
  } catch (cause) {
    throw new Error(
      'bun:sqlite is only available in Bun or Cottontail (Bun-like) runtimes.',
      { cause },
    );
  }
}

function numberResult(value: number | bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`SQLite returned an integer outside JavaScript's safe range: ${value}`);
  }
  return n;
}

/**
 * Extract named parameters (prefix @, : or $) in first-appearance order. SQLite
 * binds every occurrence of the same name to one slot and treats the prefixes
 * as interchangeable, so names dedupe by bare name. String literals, line
 * comments and block comments are skipped so their @-looking text is not
 * treated as a parameter.
 */
function collectNamedParams(sql: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < sql.length; ) {
    const ch = sql[i];
    if (ch === "'") {
      // String literal; '' escapes a quote inside.
      i += 1;
      while (i < sql.length) {
        if (sql[i] !== "'") {
          i += 1;
          continue;
        }
        if (sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === '@' || ch === ':' || ch === '$') {
      const match = /^[A-Za-z0-9_]+/.exec(sql.slice(i + 1));
      if (match) {
        if (!seen.has(match[0])) {
          seen.add(match[0]);
          names.push(match[0]);
        }
        i += 1 + match[0].length;
        continue;
      }
    }
    i += 1;
  }
  return names;
}

function isBindingsObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// bun:sqlite silently binds an object as NULL, so named-parameter calls
// (which better-sqlite3 supports) are expanded to plain positional values,
// one slot per collected name, missing keys bound as NULL.
function bindParams(names: string[], params: unknown[]): unknown[] {
  if (names.length === 0) return params;
  const out: unknown[] = [];
  for (const param of params) {
    if (isBindingsObject(param)) {
      out.push(...names.map((name) => param[name] ?? null));
    } else {
      out.push(param);
    }
  }
  return out;
}

function wrapStatement(statement: BunStatement, sql: string): DbStatement {
  // Parsed once per prepare(); the proxy hot path prepares fresh statements on
  // every request, so the SQL scan must not repeat on each get/all/run call.
  const namedParams = collectNamedParams(sql);
  return {
    get: (...params) => statement.get(...bindParams(namedParams, params)),
    all: (...params) => statement.all(...bindParams(namedParams, params)),
    run: (...params) => {
      const result = statement.run(...bindParams(namedParams, params));
      return {
        changes: numberResult(result.changes),
        lastInsertRowid: numberResult(result.lastInsertRowid),
      };
    },
  };
}

/**
 * `bun:sqlite` adapter used on the Cottontail desktop runtime, where
 * better-sqlite3 is unavailable. Same shape as node-sqlite.ts: expose only the
 * small synchronous database contract the server uses, and implement
 * better-sqlite3-style nested transactions with savepoints.
 */
export const bunSqliteFactory: DbFactory = (resolvedPath) => {
  const { Database } = loadBunSqlite();
  // create: true — bun:sqlite defaults to opening existing files only, while
  // the server always opens-or-creates.
  const raw = new Database(resolvedPath, { create: true });
  let transactionDepth = 0;
  let savepointSequence = 0;

  const database: Db = {
    name: resolvedPath,
    memory: resolvedPath === ':memory:',
    prepare: (sql) => wrapStatement(raw.prepare(sql) as BunStatement, sql),
    // bun:sqlite has no exec(); run() accepts multi-statement SQL.
    exec: (sql) => void raw.run(sql),
    pragma: (source) => raw.query(`PRAGMA ${source}`).get() as unknown,
    close: () => raw.close(),
    transaction: <F extends (...args: any[]) => unknown>(fn: F): F => {
      const wrapped = function (this: unknown, ...args: Parameters<F>): ReturnType<F> {
        const outermost = transactionDepth === 0;
        const savepoint = `freellmapi_tx_${++savepointSequence}`;

        raw.run(outermost ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
        transactionDepth += 1;

        try {
          const result = fn.apply(this, args) as ReturnType<F>;
          if (result && typeof (result as { then?: unknown }).then === 'function') {
            throw new Error('SQLite transaction callbacks must be synchronous');
          }
          raw.run(outermost ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          try {
            if (outermost) {
              raw.run('ROLLBACK');
            } else {
              raw.run(`ROLLBACK TO SAVEPOINT ${savepoint}`);
              raw.run(`RELEASE SAVEPOINT ${savepoint}`);
            }
          } catch {
            // Preserve the original callback/commit error.
          }
          throw error;
        } finally {
          transactionDepth -= 1;
        }
      };
      return wrapped as F;
    },
  };

  return database;
};