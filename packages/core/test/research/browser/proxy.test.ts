// The browser's only route to the network: real loopback sockets, an injected resolver, no internet.
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { connect, createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startGuardedProxy } from '../../../src/research/browser/proxy';

type Proxy = Awaited<ReturnType<typeof startGuardedProxy>>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function proxy(opts: Parameters<typeof startGuardedProxy>[0]): Promise<Proxy> {
  const p = await startGuardedProxy(opts);
  cleanups.push(() => p.close());
  return p;
}

/** A loopback TCP server that counts connections (stands in for any upstream). */
async function sentinel(onSocket?: (s: Socket) => void): Promise<{ port: number; connections: () => number }> {
  let n = 0;
  const server = createNetServer((s) => {
    n++;
    s.on('error', () => {});
    if (onSocket) onSocket(s);
    else s.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { port: (server.address() as AddressInfo).port, connections: () => n };
}

/** Sends raw bytes to the proxy and resolves with the first response line. */
function raw(port: number, text: string): Promise<{ line: string; socket: Socket; data: () => string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let buf = '';
    let done = false;
    socket.on('error', (e) => (done ? undefined : reject(e)));
    socket.on('data', (d) => {
      buf += d.toString('latin1');
      if (!done && buf.includes('\r\n')) {
        done = true;
        resolve({ line: buf.slice(0, buf.indexOf('\r\n')), socket, data: () => buf });
      }
    });
    socket.on('close', () => {
      if (!done) {
        done = true;
        resolve({ line: buf.split('\r\n')[0] ?? '', socket, data: () => buf });
      }
    });
    socket.write(text);
    cleanups.push(async () => void socket.destroy());
  });
}

const resolverFor = (map: Record<string, string>) =>
  vi.fn(async (host: string) => {
    const address = map[host];
    if (!address) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return [{ address, family: address.includes(':') ? 6 : 4 }];
  });

const notBlocked = () => false;

describe('startGuardedProxy: refusals', () => {
  for (const address of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '::1', 'fe80::1']) {
    it(`CONNECT to a host resolving to ${address} gets 403 and no upstream socket`, async () => {
      const dials: unknown[] = [];
      const lookup = resolverFor({ 'evil.example': address });
      const p = await proxy({ lookup, isBlockedHost: notBlocked, onDial: (a) => dials.push(a) });
      const r = await raw(p.port, 'CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n');
      expect(r.line).toMatch(/^HTTP\/1\.1 403/);
      expect(dials).toEqual([]);
      expect(lookup).toHaveBeenCalledTimes(1);
    });
  }

  it('a loopback upstream really listening is never reached', async () => {
    const s = await sentinel();
    const p = await proxy({ lookup: resolverFor({ 'rebind.example': '127.0.0.1' }), isBlockedHost: notBlocked });
    const c = await raw(p.port, `CONNECT rebind.example:${s.port} HTTP/1.1\r\n\r\n`);
    expect(c.line).toMatch(/^HTTP\/1\.1 403/);
    const g = await raw(p.port, `GET http://rebind.example:${s.port}/ HTTP/1.1\r\nHost: rebind.example\r\n\r\n`);
    expect(g.line).toMatch(/^HTTP\/1\.1 403/);
    const lit = await raw(p.port, `GET http://127.0.0.1:${s.port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
    expect(lit.line).toMatch(/^HTTP\/1\.1 403/);
    expect(s.connections()).toBe(0);
  });

  it('refuses IP-literal private targets without resolving', async () => {
    const lookup = resolverFor({});
    const p = await proxy({ lookup, isBlockedHost: notBlocked });
    for (const t of ['CONNECT 169.254.169.254:443 HTTP/1.1', 'CONNECT [::1]:443 HTTP/1.1', 'GET http://169.254.169.254/latest/meta-data HTTP/1.1', 'GET http://[::ffff:127.0.0.1]/ HTTP/1.1']) {
      expect((await raw(p.port, `${t}\r\n\r\n`)).line, t).toMatch(/^HTTP\/1\.1 403/);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses banned, never-fetch and local names before resolving', async () => {
    const lookup = resolverFor({ 'www.reddit.com': '93.184.216.34', 'gamersgetaway.ca': '93.184.216.34', localhost: '93.184.216.34' });
    const isBlockedHost = vi.fn((h: string) => h === 'www.reddit.com');
    const p = await proxy({ lookup, isBlockedHost });
    for (const host of ['www.reddit.com', 'gamersgetaway.ca', 'shop.gamersgetaway.ca', 'localhost', 'db.internal', 'printer.local']) {
      expect((await raw(p.port, `CONNECT ${host}:443 HTTP/1.1\r\n\r\n`)).line, host).toMatch(/^HTTP\/1\.1 403/);
    }
    expect((await raw(p.port, 'GET http://WWW.Reddit.com./x HTTP/1.1\r\n\r\n')).line).toMatch(/^HTTP\/1\.1 403/);
    expect(isBlockedHost).toHaveBeenCalledWith('www.reddit.com');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses CONNECT to any port but 443, and plain GET to any port but 80', async () => {
    const dials: unknown[] = [];
    const p = await proxy({ lookup: resolverFor({ 'ok.example': '93.184.216.34' }), isBlockedHost: notBlocked, onDial: (a) => dials.push(a) });
    for (const t of ['CONNECT ok.example:22 HTTP/1.1', 'CONNECT ok.example:8443 HTTP/1.1', 'CONNECT ok.example:80 HTTP/1.1', 'GET http://ok.example:5432/ HTTP/1.1', 'GET http://ok.example:443/ HTTP/1.1']) {
      expect((await raw(p.port, `${t}\r\n\r\n`)).line, t).toMatch(/^HTTP\/1\.1 403/);
    }
    expect(dials).toEqual([]);
  });

  it('refuses POST, PUT, other methods, https:// absolute GETs, origin-form requests and userinfo', async () => {
    const dials: unknown[] = [];
    const p = await proxy({ lookup: resolverFor({ 'ok.example': '93.184.216.34' }), isBlockedHost: notBlocked, onDial: (a) => dials.push(a) });
    for (const t of [
      'POST http://ok.example/ HTTP/1.1\r\nContent-Length: 0', 'PUT http://ok.example/ HTTP/1.1', 'DELETE http://ok.example/ HTTP/1.1',
      'HEAD http://ok.example/ HTTP/1.1', 'OPTIONS http://ok.example/ HTTP/1.1', 'GET https://ok.example/ HTTP/1.1', 'GET / HTTP/1.1\r\nHost: ok.example',
      'GET http://user:pw@ok.example/ HTTP/1.1', 'GET ftp://ok.example/ HTTP/1.1',
    ]) {
      expect((await raw(p.port, `${t}\r\n\r\n`)).line, t).toMatch(/^HTTP\/1\.1 403/);
    }
    expect(dials).toEqual([]);
  });

  it('refuses a websocket upgrade over plain HTTP', async () => {
    const p = await proxy({ lookup: resolverFor({ 'ok.example': '93.184.216.34' }), isBlockedHost: notBlocked });
    const r = await raw(p.port, 'GET http://ok.example/ws HTTP/1.1\r\nHost: ok.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    expect(r.line).toMatch(/^HTTP\/1\.1 403/);
  });

  it('refuses a host whose resolution includes any private address, and a lookup failure', async () => {
    const lookup = vi.fn(async (h: string) => {
      if (h === 'mixed.example') return [{ address: '93.184.216.34', family: 4 }, { address: '10.1.2.3', family: 4 }];
      throw new Error('ENOTFOUND');
    });
    const p = await proxy({ lookup, isBlockedHost: notBlocked });
    expect((await raw(p.port, 'CONNECT mixed.example:443 HTTP/1.1\r\n\r\n')).line).toMatch(/^HTTP\/1\.1 403/);
    expect((await raw(p.port, 'CONNECT nowhere.example:443 HTTP/1.1\r\n\r\n')).line).toMatch(/^HTTP\/1\.1 (403|502)/);
  });
});

describe('startGuardedProxy: allowed traffic (loopback upstreams in test mode)', () => {
  it('proxies a plain GET to the pinned address with the Host header kept', async () => {
    const seen: { url?: string; host?: string; method?: string; proxyHeader?: string }[] = [];
    const upstream: Server = createHttpServer((req, res) => {
      seen.push({ url: req.url, host: req.headers.host, method: req.method, proxyHeader: req.headers['proxy-authorization'] as string | undefined });
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<p>hello</p>');
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => upstream.close(() => r())));
    const port = (upstream.address() as AddressInfo).port;
    const lookup = resolverFor({ 'site.example': '127.0.0.1' });
    const p = await proxy({ lookup, isBlockedHost: notBlocked, allowLoopbackForTests: true });
    const body = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: p.port, method: 'GET', path: `http://site.example:${port}/a?b=1`, headers: { host: `site.example:${port}`, 'proxy-authorization': 'x' } }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode!, body: b }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(body).toEqual({ status: 200, body: '<p>hello</p>' });
    expect(seen).toEqual([{ url: '/a?b=1', host: `site.example:${port}`, method: 'GET', proxyHeader: undefined }]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('pins the DNS answer: one lookup per CONNECT, and the tunnel goes to that address', async () => {
    const s = await sentinel((sock) => sock.on('data', (d) => sock.end(`echo:${d}`)));
    let calls = 0;
    // A rebinding resolver: the first answer is the (test-allowed) loopback upstream, any later one is metadata.
    const lookup = vi.fn(async () => (calls++ === 0 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '169.254.169.254', family: 4 }]));
    const dials: { address: string; port: number }[] = [];
    const p = await proxy({ lookup, isBlockedHost: notBlocked, allowLoopbackForTests: true, onDial: (d) => dials.push(d) });
    const r = await raw(p.port, `CONNECT rebind.example:${s.port} HTTP/1.1\r\nHost: rebind.example:${s.port}\r\n\r\n`);
    expect(r.line).toMatch(/^HTTP\/1\.1 200/);
    r.socket.write('ping');
    await new Promise<void>((res) => r.socket.on('close', () => res()));
    expect(r.data()).toContain('echo:ping');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(dials).toEqual([{ address: '127.0.0.1', port: s.port }]);
    expect(s.connections()).toBe(1);
  });

  it('test mode still refuses private (non-loopback) addresses and metadata', async () => {
    const p = await proxy({ lookup: resolverFor({ 'a.example': '10.0.0.1', 'b.example': '169.254.169.254' }), isBlockedHost: notBlocked, allowLoopbackForTests: true });
    expect((await raw(p.port, 'CONNECT a.example:443 HTTP/1.1\r\n\r\n')).line).toMatch(/^HTTP\/1\.1 403/);
    expect((await raw(p.port, 'CONNECT b.example:443 HTTP/1.1\r\n\r\n')).line).toMatch(/^HTTP\/1\.1 403/);
  });
});

describe('startGuardedProxy: lifecycle', () => {
  it('listens on 127.0.0.1 only, on a random port, and closes cleanly with open tunnels', async () => {
    const s = await sentinel((sock) => sock.on('data', () => {}));
    const p = await startGuardedProxy({ lookup: resolverFor({ 'x.example': '127.0.0.1' }), isBlockedHost: notBlocked, allowLoopbackForTests: true });
    expect(p.port).toBeGreaterThan(0);
    expect(p.address).toBe('127.0.0.1');
    const r = await raw(p.port, `CONNECT x.example:${s.port} HTTP/1.1\r\n\r\n`);
    expect(r.line).toMatch(/^HTTP\/1\.1 200/);
    const closed = new Promise<void>((res) => r.socket.on('close', () => res()));
    await p.close();
    await closed;
    await expect(raw(p.port, 'CONNECT x.example:443 HTTP/1.1\r\n\r\n')).rejects.toThrow();
  });
});
