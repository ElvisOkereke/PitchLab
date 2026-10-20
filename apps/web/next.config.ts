import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

/** The npm workspaces root: the nearest folder above the app whose package.json declares `workspaces`. */
function findRepoRoot(start: string): string {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && 'workspaces' in JSON.parse(readFileSync(pkg, 'utf8'))) return dir;
    if (dirname(dir) === dir) throw new Error('next.config: could not find the workspaces root');
  }
}

const repoRoot = findRepoRoot(process.cwd());
// The repo root .env is the single env file (no apps/web/.env).
loadEnvConfig(repoRoot, process.env.NODE_ENV !== 'production');

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Core is consumed as TypeScript source through its exports map (`@bcg/core/<path>`).
  transpilePackages: ['@bcg/core'],
  serverExternalPackages: ['pg', '@electric-sql/pglite', '@electric-sql/pglite-pgvector'],
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // Hostnames (e.g. the PC's LAN IP) allowed to load dev resources, so a phone on the same Wi-Fi can use `next dev`.
  allowedDevOrigins: list(process.env.DEV_ORIGINS),
  experimental: {
    serverActions: { allowedOrigins: list(process.env.ALLOWED_ORIGINS) },
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
