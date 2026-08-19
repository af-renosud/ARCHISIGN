import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    // On NixOS the downloaded Playwright browsers miss shared libs; point at
    // the system chromium instead (E2E_CHROMIUM_PATH=$(which chromium)).
    launchOptions: process.env.E2E_CHROMIUM_PATH
      ? { executablePath: process.env.E2E_CHROMIUM_PATH }
      : {},
    baseURL: process.env.E2E_BASE_URL || "http://localhost:5000",
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
});
