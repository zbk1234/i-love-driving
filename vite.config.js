import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5183, strictPort: false, open: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
});
