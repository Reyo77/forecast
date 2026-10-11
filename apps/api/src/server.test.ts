import { spawnSync } from 'node:child_process';
import path from 'node:path';

describe('server startup', () => {
  it('refuses to start when a required env var is missing', () => {
    const api = path.resolve(__dirname, '..');
    const result = spawnSync(path.resolve(api, '../../node_modules/.bin/tsx'), ['src/server.ts'], {
      cwd: api,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ENV_FILE: '/nonexistent/.env' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Invalid environment configuration/);
  });
});
