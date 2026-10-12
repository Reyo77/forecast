import { loadEnv } from './env';

const valid = {
  DATABASE_URL: 'mysql://a:b@localhost:3306/x',
  DATABASE_URL_TEST: 'mysql://a:b@localhost:3307/y',
  JWT_ACCESS_SECRET: 's1',
  JWT_REFRESH_SECRET: 's2',
  APP_URL: 'http://localhost:5173',
  API_URL: 'http://localhost:4000',
  GEMINI_API_KEY: 'k',
  GEMINI_MODEL: 'gemini-2.5-flash',
  SIMULATED_PAYMENTS: 'true',
  SUPER_ADMIN_EMAIL: 'admin@supplycast.local',
  SUPER_ADMIN_PASSWORD: 'pw',
};

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    const env = loadEnv(valid as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(4000);
    expect(env.SIMULATED_PAYMENTS).toBe(true);
  });

  it('defaults the auth rate limit to 20 and accepts an override', () => {
    expect(loadEnv(valid as NodeJS.ProcessEnv).AUTH_RATE_LIMIT_MAX).toBe(20);
    expect(
      loadEnv({ ...valid, AUTH_RATE_LIMIT_MAX: '500' } as NodeJS.ProcessEnv).AUTH_RATE_LIMIT_MAX,
    ).toBe(500);
  });

  it('throws naming the missing variable', () => {
    const rest: Record<string, string> = { ...valid };
    delete rest.JWT_ACCESS_SECRET;
    expect(() => loadEnv(rest as NodeJS.ProcessEnv)).toThrow(/JWT_ACCESS_SECRET/);
  });
});
