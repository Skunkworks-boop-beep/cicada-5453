import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for Cicada-5453 e2e smoke tests.
 *
 * The tests run against the dev-stub bridge (bridge/dev_stub.py) on
 * :5000 plus the FastAPI backend on :8000 and the Vite dev server on
 * :5173. Operators are expected to start those three services
 * separately before running the suite — see e2e/README.md for the
 * one-line invocations.
 *
 * For CI we also want a `--with-services` mode that boots the three
 * processes via webServer; that's a follow-up.
 */

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // shared backend state — order matters
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    trace: 'retain-on-failure',
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
