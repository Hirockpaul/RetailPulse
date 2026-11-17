import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// One happy path through the real UI, real API and real PostgreSQL (its own throw-away
// database, see e2e/start-api.mjs). Ports differ from the dev servers so both can run at once.
const API_PORT = 3100;
const WEB_PORT = 5174;

const rootEnv = resolve(import.meta.dirname, '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
process.env.DEMO_PASSWORD ??= 'e2e-demo-password-1'; // seeds the e2e database and signs in

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
  },
  // Servers are "ready" when they log that they listen. (Waiting on a URL makes Playwright
  // probe the port first, which hangs ~2 minutes on WSL2 mirrored networking.)
  webServer: [
    {
      command: 'node e2e/start-api.mjs',
      wait: { stdout: /API listening on/ },
      env: { E2E_API_PORT: String(API_PORT) },
      timeout: 120_000,
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      wait: { stdout: new RegExp(`localhost:${WEB_PORT}`) },
      env: { API_PROXY_TARGET: `http://localhost:${API_PORT}` },
      timeout: 60_000,
    },
  ],
});
