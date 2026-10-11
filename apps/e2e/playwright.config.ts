import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const apiUrl = process.env.API_URL ?? 'http://localhost:4000';
const webUrl = process.env.APP_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './tests',
  use: { baseURL: webUrl },
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
