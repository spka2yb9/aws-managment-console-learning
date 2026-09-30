import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Relative base + hash routing: works under any GitHub Pages subpath (/<repo>/) without knowing the repo name.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 2500,
    // Cloudscape is most of the bundle and changes rarely: its own chunk caches across app updates
    rollupOptions: { output: { manualChunks: (id) => (id.includes('node_modules/@cloudscape-design/') ? 'cloudscape' : undefined) } },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
