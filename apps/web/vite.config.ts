/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  return {
    plugins: [react()],
    server: {
      port: Number(env.WEB_PORT ?? 5173),
      strictPort: true,
      proxy: {
        '/api': {
          target: env.API_URL ?? 'http://localhost:4000',
          cookiePathRewrite: { '/auth': '/api/auth' },
          rewrite: (p) => p.replace(/^\/api/, ''),
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./tests/setup.ts'],
      include: ['src/**/*.test.tsx', 'tests/**/*.test.tsx'],
      coverage: { include: ['src/**'], exclude: ['src/main.tsx'], thresholds: { lines: 70 } },
    },
  };
});
