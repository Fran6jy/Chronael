import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against a PRODUCTION build (vite build + vite preview), the same
// bundle users get. VITE_E2E=1 only exposes a small test hook (window.__chronael) so
// tests can set up positions such as a pawn about to promote.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npm run build:e2e && npx vite preview --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
