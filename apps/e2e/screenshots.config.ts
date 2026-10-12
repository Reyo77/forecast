import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const apiUrl = process.env.API_URL ?? 'http://localhost:4000';
const webUrl = process.env.APP_URL ?? 'http://localhost:5173';

// Generates the README screenshots from the seeded demo tenant (npm run screenshots).
export default defineConfig({
  testDir: './screenshots',
  timeout: 180_000,
  use: { baseURL: webUrl, viewport: { width: 1360, height: 860 } },
  webServer: [
    {
      command: 'npm run dev -w apps/api',
      cwd: '../..',
      url: `${apiUrl}/health`,
      reuseExistingServer: true,
    },
    { command: 'npm run dev -w apps/web', cwd: '../..', url: webUrl, reuseExistingServer: true },
  ],
});
