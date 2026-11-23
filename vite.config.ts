import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Lifo (CLI 版のシェル) が動的 import するが、ブラウザでは使われないもの
const stub = fileURLToPath(new URL('./src/cli/shell/stub.ts', import.meta.url));

/* Vite は node_modules の中身を見ないので、patch-lifo.mjs で書き換えても事前バンドルを作り直さない。
   パッチの中身をバンドルに刻んで、変えたら作り直されるようにする (linux-learning と同じ) */
const patchHash = createHash('sha256').update(readFileSync(new URL('./scripts/patch-lifo.mjs', import.meta.url))).digest('hex').slice(0, 8);

// Relative base + hash routing: works under any GitHub Pages subpath (/<repo>/) without knowing the repo name.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: { alias: { '@lifo-sh/ui': stub, ws: stub } },
  optimizeDeps: { rolldownOptions: { output: { footer: `/* patch-lifo ${patchHash} */` } } },
  build: {
    chunkSizeWarningLimit: 2500,
    // Cloudscape is most of the bundle and changes rarely: its own chunk caches across app updates
    rollupOptions: { output: { manualChunks: (id) => (id.includes('node_modules/@cloudscape-design/') ? 'cloudscape' : undefined) } },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // Cloudscape pages rendered in jsdom are slow when every test file runs in parallel
    testTimeout: 30_000,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
