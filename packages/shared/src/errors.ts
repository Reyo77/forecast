import { z } from 'zod';

export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ErrorBody = z.infer<typeof errorBodySchema>;
