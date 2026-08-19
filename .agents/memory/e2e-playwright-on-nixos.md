---
name: Running Playwright e2e in this workspace
description: How to actually run the tests/e2e suite here (NixOS browser + server lifetime gotchas)
---

**Rule:** `npx playwright install chromium` downloads a browser that fails on NixOS (`libgbm.so.1` missing). Use the system chromium instead: install nix package `chromium`, then run with `E2E_CHROMIUM_PATH=$(which chromium)` (playwright.config.ts wires it into `launchOptions.executablePath`).

**Also:** background servers started in one shell command are killed when that command exits (even with setsid/nohup). Start the e2e server and run playwright in the SAME shell command:
`(E2E_AUTH_BYPASS=1 PORT=5001 npm run dev &); wait-for /health; E2E_AUTH_BYPASS=1 E2E_BASE_URL=http://localhost:5001 E2E_CHROMIUM_PATH=$(which chromium) npx playwright test ...`

**Why:** two debugging cycles were lost to ECONNREFUSED mid-run before spotting the shell-lifetime kill; the libgbm failure looks like a Playwright bug but is environmental.
