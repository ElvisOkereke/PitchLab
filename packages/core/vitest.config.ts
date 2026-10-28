import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Each DB test boots its own PGlite (wasm + migrations); under parallel workers that alone can exceed the 5s default.
  test: { include: ['test/**/*.test.ts'], globals: true, testTimeout: 30_000, hookTimeout: 30_000 },
});
