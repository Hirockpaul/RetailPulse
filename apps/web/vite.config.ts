/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Component tests (V2 6-1, decision D5): jsdom + Testing Library; the network is faked per test.
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx'],
    setupFiles: ['./src/test/setup.ts'],
  },
  server: {
    port: 5173,
    // The e2e test points the proxy at its own API instance (see playwright.config.ts).
    // Forward the browser-facing host/protocol so API same-origin validation sees the real origin.
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000',
        xfwd: true,
      },
    },
  },
});
