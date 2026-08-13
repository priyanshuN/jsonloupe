// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5201',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-light',
      use: { ...devices['Desktop Chrome'], colorScheme: 'light' },
    },
    {
      name: 'chromium-dark',
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark' },
    },
  ],
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 5201 --strictPort',
    url: 'http://127.0.0.1:5201',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
