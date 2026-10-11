import { createApp } from '../../src/app';

/** App for integration tests: auth rate limit effectively off. */
export const testApp = () =>
  createApp(
    { APP_URL: 'http://localhost:5173', JWT_ACCESS_SECRET: 'test-access-secret' },
    { loginRateLimitMax: 1_000_000 },
  );

export const tokenFromLink = (link: string) => new URL(link).searchParams.get('token')!;
