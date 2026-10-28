import { promises as dns } from 'node:dns';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, isIP, type AddressInfo, type Socket } from 'node:net';
import ipaddr from 'ipaddr.js';
import { isNeverFetchHost } from '../../tools/banned-sources';
import { isAllowedIp } from '../../tools/fetch-page';

/**
 * The local browser's only route to the network: a forwarding proxy on 127.0.0.1 (random port, alive for one mission).
 *
 * DNS rebinding: Chromium never resolves or dials page hosts itself. Each CONNECT host or plain-HTTP host is resolved
 * here exactly once, every answer must be a public unicast address (isAllowedIp, shared with fetchPage), and the socket
 * is opened to that checked address, never to the name. A second, different DNS answer cannot be used.
 *
 * Allowed: CONNECT to port 443 (an opaque TLS tunnel; the browser validates the certificate for the name) and GET with
 * an absolute http:// URL to port 80. Everything else, and every banned, never-fetch, local or private target, gets 403
 * before any upstream socket exists.
 */
export type GuardedLookup = (host: string) => Promise<{ address: string; family: number }[]>;

export type GuardedProxyOpts = {
  lookup?: GuardedLookup;
  /** Extra hosts to refuse (banned sources); called with the lowercased host, no trailing dot or brackets. */
  isBlockedHost: (host: string) => boolean;
  /** Tests only: loopback answers are allowed (on any port) so real loopback upstreams can be used. Never set in production. */
  allowLoopbackForTests?: boolean;
  /** Observer called just before an upstream socket is opened (tests assert pinning and that refusals never dial). */
  onDial?: (target: { address: string; port: number }) => void;
};

export type GuardedProxy = { port: number; address: '127.0.0.1'; close(): Promise<void> };

const LOOKUP_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 60_000;
const TUNNEL_PORT = 443;
const HTTP_PORT = 80;
const HOP_BY_HOP = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

const defaultLookup: GuardedLookup = (host) => dns.lookup(host, { all: true });

type Target = { host: string; port: number };
type Verdict = { ok: true; address: string; family: number } | { ok: false; status: 403 | 502 };

function isLoopback(ip: string): boolean {
  try {
    const a = ipaddr.process(ip.split('%')[0]!);
    return a.range() === 'loopback';
  } catch {
    return false;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('lookup timed out')), ms);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}

/** Lowercased host without brackets or trailing dots; null when the name is malformed or never fetchable. */
function cleanHost(rawHost: string): string | null {
  let host = rawHost.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  // The never-fetch rule sees the raw name first: an empty label ("a..b", "x.ca..") fails closed.
  if (host === '' || isNeverFetchHost(host)) return null;
  host = host.replace(/\.+$/, '');
  if (host === '' || isNeverFetchHost(host)) return null;
  if (host === 'localhost' || ['.localhost', '.local', '.internal'].some((s) => host.endsWith(s))) return null;
  return host;
}

export async function startGuardedProxy(opts: GuardedProxyOpts): Promise<GuardedProxy> {
  const lookup = opts.lookup ?? defaultLookup;
  const testLoopback = opts.allowLoopbackForTests === true;
  const sockets = new Set<Socket>();
  const track = (s: Socket) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  };
  const addressAllowed = (ip: string) => isAllowedIp(ip) || (testLoopback && isLoopback(ip));

  /** The single place a target is judged: names, ports, then one resolution whose every answer must be public. */
  async function judge(t: Target, expectedPort: number): Promise<Verdict> {
    const host = cleanHost(t.host);
    if (!host || opts.isBlockedHost(host)) return { ok: false, status: 403 };
    if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535) return { ok: false, status: 403 };
    if (t.port !== expectedPort && !testLoopback) return { ok: false, status: 403 };
    let address: string;
    let family: number;
    if (isIP(host)) {
      if (!addressAllowed(host)) return { ok: false, status: 403 };
      address = host;
      family = isIP(host);
    } else {
      let addrs: { address: string; family: number }[];
      try {
        addrs = await withTimeout(lookup(host), LOOKUP_TIMEOUT_MS);
      } catch {
        return { ok: false, status: 502 };
      }
      if (addrs.length === 0) return { ok: false, status: 502 };
      if (addrs.some((a) => !addressAllowed(a.address))) return { ok: false, status: 403 };
      address = addrs[0]!.address;
      family = addrs[0]!.family;
    }
    // In test mode only a loopback answer may use a non-standard port.
    if (t.port !== expectedPort && !(testLoopback && isLoopback(address))) return { ok: false, status: 403 };
    return { ok: true, address, family };
  }

  function refuseSocket(socket: Socket, status: 403 | 502) {
    const text = status === 403 ? 'Forbidden' : 'Bad Gateway';
    socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  }

  function refuseResponse(res: ServerResponse, status: 403 | 502) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { 'content-type': 'text/plain', connection: 'close' });
    res.end(status === 403 ? 'Refused by the PitchLab research guard\n' : 'Upstream unavailable\n');
  }

  // The absolute URL is authoritative (Host is rewritten from it), so a missing Host header is not a parse error.
  const server = createServer({ requireHostHeader: false });
  server.on('connection', (s: Socket) => {
    track(s);
    s.setTimeout(IDLE_TIMEOUT_MS, () => s.destroy());
    s.on('error', () => {});
  });
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  // WebSocket-over-plain-HTTP (and any other upgrade) is refused outright.
  server.on('upgrade', (_req: IncomingMessage, socket: Socket) => refuseSocket(socket, 403));

  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on('error', () => {});
    void (async () => {
      let target: Target;
      try {
        const u = new URL(`http://${req.url ?? ''}`);
        if (u.username || u.password || u.pathname !== '/' || u.search || u.hash || !/:\d+$/.test(req.url ?? '')) throw new Error('bad target');
        target = { host: u.hostname, port: Number(u.port || HTTP_PORT) };
      } catch {
        refuseSocket(client, 403);
        return;
      }
      const v = await judge(target, TUNNEL_PORT);
      if (!v.ok) {
        refuseSocket(client, v.status);
        return;
      }
      if (client.destroyed) return;
      opts.onDial?.({ address: v.address, port: target.port });
      const upstream = connect({ host: v.address, port: target.port, family: v.family });
      track(upstream);
      upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy());
      upstream.once('connect', () => {
        upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => {
        if (!client.destroyed) refuseSocket(client, 502);
      });
      upstream.on('close', () => client.destroy());
      client.on('close', () => upstream.destroy());
    })();
  });

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.method !== 'GET') return refuseResponse(res, 403);
      let u: URL;
      try {
        u = new URL(req.url ?? '');
      } catch {
        return refuseResponse(res, 403); // origin-form ("GET /"): nothing on the proxy itself is served
      }
      if (u.protocol !== 'http:' || u.username || u.password) return refuseResponse(res, 403);
      const te = req.headers['transfer-encoding'];
      const len = Number(req.headers['content-length'] ?? 0);
      if (te || (Number.isFinite(len) && len > 0)) return refuseResponse(res, 403);
      const target: Target = { host: u.hostname, port: Number(u.port || HTTP_PORT) };
      const v = await judge(target, HTTP_PORT);
      if (!v.ok) return refuseResponse(res, v.status);
      opts.onDial?.({ address: v.address, port: target.port });
      const upstreamReq = httpRequest({
        host: v.address, port: target.port, family: v.family, method: 'GET', path: `${u.pathname}${u.search}`,
        headers: forwardHeaders(req.headers, u.host), setHost: false, agent: false, timeout: CONNECT_TIMEOUT_MS,
      });
      upstreamReq.on('socket', (s) => track(s));
      upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timed out')));
      upstreamReq.on('error', () => refuseResponse(res, 502));
      upstreamReq.on('response', (up) => {
        const headers: IncomingHttpHeaders = {};
        for (const [k, val] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = val;
        res.writeHead(up.statusCode ?? 502, headers as Record<string, string | string[]>);
        up.pipe(res);
        up.on('error', () => res.destroy());
      });
      res.on('close', () => upstreamReq.destroy());
      upstreamReq.end();
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | null = null;
  return {
    port,
    address: '127.0.0.1',
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
        server.closeAllConnections?.();
      })),
  };
}

/** Request headers to forward: hop-by-hop and proxy credentials dropped, Host set from the URL. */
function forwardHeaders(h: IncomingHttpHeaders, host: string): Record<string, string | string[]> {
  const named = new Set(String(h.connection ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || HOP_BY_HOP.has(k) || named.has(k) || k === 'host') continue;
    out[k] = v;
  }
  out.host = host;
  return out;
}
