// Self-built RFC 1928 SOCKS5 client for the Bun/Cottontail branch of
// proxy.ts. Replaces the vendored bun-socks wrapper, which buffered whole
// responses (no streaming — fatal for LLM SSE), never wired AbortSignal into
// the response phase, and used Connection: close per request.
//
// This one: streams the response body (chunked and fixed-length alike),
// aborts destroy the tunnel socket, headers pass through untouched, and
// openSocksTunnel() is exported separately so a future keep-alive pool can
// cache handed-off sockets without touching the HTTP layer.
import * as net from 'node:net';
import * as tls from 'node:tls';

export interface Socks5Config {
  host: string;
  port: number;
  user?: string;
  pass?: string;
}

/** Parse `socks5://[user:pass@]host:port`. `socks5h:` is accepted too — both
 *  resolve the target hostname at the proxy (ATYP=3), which is the only sane
 *  behaviour on DNS-poisoned networks. Defaults to port 1080. */
export function parseProxyUrl(proxyUrl: string): Socks5Config {
  const url = new URL(proxyUrl);
  if (url.protocol !== 'socks5:' && url.protocol !== 'socks5h:') {
    throw new TypeError(`Unsupported proxy protocol "${url.protocol}" (only socks5: is supported)`);
  }
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  return {
    host,
    port: url.port ? Number(url.port) : 1080,
    user: url.username ? decodeURIComponent(url.username) : undefined,
    pass: url.password ? decodeURIComponent(url.password) : undefined,
  };
}

const HANDSHAKE_TIMEOUT_MS = 15_000;

/** RFC 1928 reply codes for CONNECT, indexed by REP byte. */
const CONNECT_REPLIES = [
  'succeeded',
  'general SOCKS server failure',
  'connection not allowed by ruleset',
  'network unreachable',
  'host unreachable',
  'connection refused',
  'TTL expired',
  'command not supported',
  'address type not supported',
];

/** The signal's own reason when set, else a fetch-style AbortError. */
function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new DOMException('The operation was aborted', 'AbortError');
}

/**
 * RFC 1928 handshake → CONNECT. Resolves with the raw tunnel socket once the
 * proxy reports success, with all proxy-phase listeners stripped so the
 * caller owns the socket. Kept separate from the HTTP layer so a future
 * keep-alive pool can cache handed-off sockets here (the pool would own the
 * lifetime and negotiate Connection: keep-alive instead of close).
 */
export function openSocksTunnel(
  cfg: Socks5Config,
  targetHost: string,
  targetPort: number,
  signal?: AbortSignal,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(cfg.port, cfg.host);
    let pending = Buffer.alloc(0);
    let stage: 'greeting' | 'auth' | 'connect' = 'greeting';

    const onAbort = (): void => {
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      reject(abortError(signal));
    };
    if (signal?.aborted) {
      socket.destroy();
      reject(abortError(signal));
      return;
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const fail = (err: Error): void => {
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      reject(err);
    };
    socket.on('error', fail);
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => fail(new Error('SOCKS5 proxy handshake timed out')));

    socket.on('connect', () => {
      const methods = cfg.user !== undefined ? [0x00, 0x02] : [0x00];
      socket.write(Buffer.from([0x05, methods.length, ...methods]));
      socket.on('data', (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        try {
          advance();
        } catch (err) {
          fail(err as Error);
        }
      });
    });

    function advance(): void {
      if (stage === 'greeting') {
        if (pending.length < 2) return;
        if (pending[0] !== 0x05) throw new Error('SOCKS5 proxy returned an invalid version byte');
        const method = pending[1];
        pending = pending.subarray(2);
        if (method === 0x00) sendConnectRequest();
        else if (method === 0x02) sendAuthRequest();
        else throw new Error(`SOCKS5 proxy rejected all offered auth methods (code ${method})`);
        return;
      }
      if (stage === 'auth') {
        if (pending.length < 2) return;
        if (pending[0] !== 0x01 || pending[1] !== 0x00) throw new Error('SOCKS5 proxy authentication failed');
        pending = pending.subarray(2);
        sendConnectRequest();
        return;
      }
      // CONNECT reply: VER REP RSV ATYP [4|1+len|16 bytes addr] 2 bytes port
      if (pending.length < 4) return;
      const replyLen = pending[3] === 0x01 ? 10 : pending[3] === 0x03 ? 7 + pending[4] : pending[3] === 0x04 ? 22 : -1;
      if (replyLen < 0) throw new Error('SOCKS5 proxy returned an unsupported address type');
      if (pending.length < replyLen) return;
      const rep = pending[1];
      if (rep !== 0x00) {
        throw new Error(`SOCKS5 CONNECT to ${targetHost}:${targetPort} failed: ${CONNECT_REPLIES[rep] ?? `code ${rep}`}`);
      }
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.setTimeout(0);
      signal?.removeEventListener('abort', onAbort);
      resolve(socket);
    }

    function sendAuthRequest(): void {
      const user = Buffer.from(cfg.user ?? '', 'utf8');
      const pass = Buffer.from(cfg.pass ?? '', 'utf8');
      const buf = Buffer.alloc(3 + user.length + pass.length);
      buf[0] = 0x01;
      buf[1] = user.length;
      user.copy(buf, 2);
      buf[2 + user.length] = pass.length;
      pass.copy(buf, 3 + user.length);
      socket.write(buf);
      stage = 'auth';
    }

    function sendConnectRequest(): void {
      const host = Buffer.from(targetHost, 'utf8');
      const port = Buffer.alloc(2);
      port.writeUInt16BE(targetPort);
      socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]));
      stage = 'connect';
    }
  });
}

/** Upgrade the tunnel to TLS for https: targets (SNI + strict verification). */
function tlsUpgrade(socket: net.Socket, servername: string, signal?: AbortSignal): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername, rejectUnauthorized: true });
    const onAbort = (): void => {
      signal?.removeEventListener('abort', onAbort);
      tlsSocket.destroy();
      reject(abortError(signal));
    };
    if (signal?.aborted) {
      tlsSocket.destroy();
      reject(abortError(signal));
      return;
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const onError = (err: Error): void => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    };
    tlsSocket.once('error', onError);
    tlsSocket.once('secureConnect', () => {
      signal?.removeEventListener('abort', onAbort);
      tlsSocket.removeListener('error', onError);
      resolve(tlsSocket);
    });
  });
}

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-connection', 'keep-alive']);

/** Write an origin-form HTTP/1.1 request onto the tunnel. The body is
 *  buffered to derive Content-Length (streaming uploads are out of scope for
 *  v1); headers pass through untouched except hop-by-hop ones. */
function writeRequest(socket: net.Socket | tls.TLSSocket, url: URL, req: Request, bodyBytes: Uint8Array): void {
  const path = url.pathname + url.search || '/';
  const lines = [`${req.method} ${path} HTTP/1.1`, `Host: ${url.host}`, 'Connection: close'];
  req.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase())) lines.push(`${name}: ${value}`);
  });
  if (bodyBytes.byteLength > 0) lines.push(`Content-Length: ${bodyBytes.byteLength}`);
  socket.write(lines.join('\r\n') + '\r\n\r\n');
  if (bodyBytes.byteLength > 0) socket.write(bodyBytes);
}

function parseHead(headText: string): { status: number; statusText: string; headers: Headers } {
  const lines = headText.split('\r\n');
  const [, statusStr, ...statusParts] = lines[0].split(' ');
  const status = Number(statusStr);
  if (!status || status < 100 || status > 599) throw new Error(`Invalid HTTP status line: ${lines[0]}`);
  const headers = new Headers();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const sep = line.indexOf(':');
    if (sep > 0) headers.append(line.slice(0, sep).trim(), line.slice(sep + 1).trim());
  }
  return { status, statusText: statusParts.join(' '), headers };
}

interface DrainResult {
  status: number;
  statusText: string;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
}

/**
 * Read the response head from the tunnel, then hand the body out as a
 * streaming ReadableStream — chunked transfer-encoding is de-framed on the
 * fly so SSE consumers see raw event lines, and back-pressure pauses the
 * socket when the reader lags. Abort after the head errors the body stream
 * (fetch semantics), abort before it rejects the whole promise.
 */
function drainResponse(socket: net.Socket | tls.TLSSocket, signal?: AbortSignal): Promise<DrainResult> {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    let phase: 'head' | 'body' | 'chunk-size' | 'chunk-data' | 'chunk-crlf' | 'chunk-trailer' = 'head';
    let knownLen: number | null = null;
    let remaining = 0;
    let chunkBytes = 0;
    let done = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
      signal?.removeEventListener('abort', onAbort);
      if (controller) {
        if (err) controller.error(err);
        else controller.close();
      } else if (err) reject(err);
      else reject(new Error('connection closed before response headers'));
      socket.destroy();
    };

    const onData = (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk]);
      pump();
    };
    const onError = (err: Error): void => finish(err);
    const onEnd = (): void => {
      if (done) return;
      if (phase === 'head') finish(new Error('connection closed before response headers'));
      else if (phase === 'body' && knownLen === null) finish();
      else finish(new Error('response body truncated'));
    };
    const onAbort = (): void => {
      socket.destroy();
      finish(abortError(signal));
    };
    if (signal?.aborted) {
      socket.destroy();
      finish(abortError(signal));
      return;
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);

    function emit(bytes: Buffer): void {
      controller?.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      if (controller && controller.desiredSize !== null && controller.desiredSize <= 0) socket.pause();
    }

    function pump(): void {
      if (done) return;
      try {
        while (pending.length > 0) {
          if (phase === 'head') {
            const idx = pending.indexOf('\r\n\r\n');
            if (idx === -1) return;
            const head = parseHead(pending.subarray(0, idx).toString('latin1'));
            pending = pending.subarray(idx + 4);
            const chunked = head.headers.get('transfer-encoding')?.toLowerCase().includes('chunked') ?? false;
            const cl = head.headers.get('content-length');
            knownLen = chunked ? null : cl !== null && Number.isFinite(Number(cl)) ? Number(cl) : null;
            remaining = knownLen ?? 0;
            phase = chunked ? 'chunk-size' : 'body';
            let body: ReadableStream<Uint8Array> | null = null;
            body = new ReadableStream<Uint8Array>({
              start(c) {
                controller = c;
              },
              pull() {
                socket.resume();
              },
              cancel() {
                finish();
              },
            });
            resolve({ status: head.status, statusText: head.statusText, headers: head.headers, body });
            continue;
          }
          if (phase === 'body') {
            if (knownLen !== null) {
              const take = Math.min(pending.length, remaining);
              if (take > 0) {
                emit(pending.subarray(0, take));
                pending = pending.subarray(take);
                remaining -= take;
              }
              if (remaining === 0) {
                finish();
                return;
              }
              if (take === 0) return; // close-delimited guard, unreachable for fixed
            } else {
              emit(pending);
              pending = Buffer.alloc(0);
            }
            continue;
          }
          if (phase === 'chunk-size') {
            const nl = pending.indexOf('\r\n');
            if (nl === -1) return;
            const line = pending.subarray(0, nl).toString('latin1').trim();
            pending = pending.subarray(nl + 2);
            const size = parseInt(line.split(';')[0], 16);
            if (!Number.isFinite(size)) throw new Error('invalid chunk size line');
            if (size === 0) phase = 'chunk-trailer';
            else {
              chunkBytes = size;
              phase = 'chunk-data';
            }
            continue;
          }
          if (phase === 'chunk-data') {
            if (pending.length < chunkBytes) return;
            emit(pending.subarray(0, chunkBytes));
            pending = pending.subarray(chunkBytes);
            phase = 'chunk-crlf';
            continue;
          }
          if (phase === 'chunk-crlf') {
            if (pending.length < 2) return;
            if (pending[0] !== 0x0d || pending[1] !== 0x0a) throw new Error('malformed chunk terminator');
            pending = pending.subarray(2);
            phase = 'chunk-size';
            continue;
          }
          // chunk-trailer: lines until an empty one ends the message
          const nl = pending.indexOf('\r\n');
          if (nl === -1) return;
          if (nl === 0) {
            finish();
            return;
          }
          pending = pending.subarray(nl + 2);
        }
      } catch (err) {
        finish(err as Error);
      }
    }
  });
}

/**
 * Fetch-compatible SOCKS5 request: `socksFetch(url, init, proxyUrl)` behaves
 * like `fetch()` but routes through the proxy. Requires proxyUrl to name a
 * socks5/socks5h scheme. Errors mirror undici: transport/protocol failures
 * reject with `TypeError: fetch failed` carrying the underlying error in
 * `cause`; aborts reject with the signal's reason (AbortError).
 */
export async function socksFetch(
  input: string | URL | Request,
  init?: RequestInit,
  proxyUrl?: string,
): Promise<Response> {
  const cfg = proxyUrl ? parseProxyUrl(proxyUrl) : null;
  if (!cfg) return globalThis.fetch(input, init);

  try {
    const req = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const url = new URL(req.url);
    const isHttps = url.protocol === 'https:';
    const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
    const signal = req.signal;
    const bodyBytes = new Uint8Array(await req.arrayBuffer());

    const tunnel = await openSocksTunnel(cfg, url.hostname, port, signal);
    const socket = isHttps ? await tlsUpgrade(tunnel, url.hostname, signal) : tunnel;
    writeRequest(socket, url, req, bodyBytes);
    const { status, statusText, headers, body } = await drainResponse(socket, signal);
    return new Response(body, { status, statusText, headers });
  } catch (err) {
    const e = err as Error;
    if (e?.name === 'AbortError') throw e;
    throw new TypeError('fetch failed', { cause: e });
  }
}