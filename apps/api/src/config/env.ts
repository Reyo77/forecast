import { z } from 'zod';

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1),
    DATABASE_URL_TEST: z.string().min(1),
    JWT_ACCESS_SECRET: z.string().min(1),
    JWT_REFRESH_SECRET: z.string().min(1),
    APP_URL: z.string().url(),
    API_URL: z.string().url(),
    GEMINI_API_KEY: z.string().min(1),
    GEMINI_MODEL: z.string().min(1),
    /** `fake` swaps in a deterministic offline AI (development and end-to-end tests only). */
    AI_PROVIDER: z.enum(['gemini', 'fake']).default('gemini'),
    /** Sign-up/login attempts allowed per IP per 15 minutes. Raise only for local end-to-end runs. */
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
    /** `log` records emails without sending (default); `smtp` delivers through SMTP_*. */
    EMAIL_PROVIDER: z.enum(['log', 'smtp']).default('log'),
    EMAIL_FROM: z.string().min(3).default('SupplyCast <no-reply@supplycast.local>'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SIMULATED_PAYMENTS: z.enum(['true', 'false']).transform((v) => v === 'true'),
    SUPER_ADMIN_EMAIL: z.string().email(),
    SUPER_ADMIN_PASSWORD: z.string().min(1),
  })
  .superRefine((v, ctx) => {
    if (v.EMAIL_PROVIDER === 'smtp' && !v.SMTP_HOST) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_HOST'],
        message: 'SMTP_HOST is required when EMAIL_PROVIDER=smtp',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}
