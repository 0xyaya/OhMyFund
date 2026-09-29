import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4320);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run build && npm run start -- --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    env: {
      NEXT_PUBLIC_TURNKEY_ORGANIZATION_ID: '11111111-1111-4111-8111-111111111111',
      NEXT_PUBLIC_TURNKEY_AUTH_PROXY_ID: 'test-auth-proxy',
      API_ORIGIN: 'http://127.0.0.1:4310',
      API_PROXY_SECRET: 'test-proxy-secret'
    }
  }
});
