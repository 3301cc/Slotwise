import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /audit\.spec\.ts/,
  timeout: 60_000,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'report', open: 'never' }]],
  use: {
    ignoreHTTPSErrors: false,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-3p-blocked',
      use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--block-third-party-cookies', '--disable-features=ThirdPartyStoragePartitioning'] } },
    },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit-itp', use: { ...devices['Desktop Safari'] } },
    { name: 'iphone', use: { ...devices['iPhone 14'] } },
  ],
});
