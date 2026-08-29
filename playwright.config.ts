// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
import { defineConfig, devices } from '@playwright/test';

/**
 * The WebMCP bridge needs Chromium launched with the origin-trial flags, and
 * everything else needs a Chromium launched WITHOUT them — webmcp-absent.e2e.ts
 * exists precisely to prove the app is inert when the API is missing. Launch
 * args are per-project, so the flagged browser gets its own project and the two
 * default projects skip the one file that needs it.
 */
const WEBMCP_SPEC = '**/webmcp.e2e.ts';

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
      testIgnore: WEBMCP_SPEC,
      use: { ...devices['Desktop Chrome'], colorScheme: 'light' },
    },
    {
      name: 'chromium-dark',
      testIgnore: WEBMCP_SPEC,
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark' },
    },
    {
      // Chrome 149+ only, and only behind the flags: WebMCP exposes
      // document.modelContext, WebMCPTesting lets a driver call the tools the
      // page registered. One colour scheme is enough — nothing here is visual.
      name: 'chromium-webmcp',
      testMatch: WEBMCP_SPEC,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--enable-features=WebMCP,WebMCPTesting'] },
      },
    },
  ],
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 5201 --strictPort',
    url: 'http://127.0.0.1:5201',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
