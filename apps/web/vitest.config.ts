import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

const serverOnlyStub = fileURLToPath(new URL('./test/stubs/server-only.ts', import.meta.url));

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  resolve: { alias: { 'server-only': serverOnlyStub } },
  test: {
    // Each DB test boots its own PGlite (wasm + migrations), which can exceed the 5 s default under parallel workers.
    testTimeout: 30_000,
    // Vitest 5 inline projects inherit the plugins and aliases above.
    projects: [
      { test: { name: 'node', include: ['test/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'dom', include: ['test/**/*.test.tsx'], environment: 'jsdom' } },
    ],
  },
});
