import { z } from 'zod';

export const ROLES = ['SUPER_ADMIN', 'OWNER', 'ADMIN', 'PLANNER', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number');

const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email').max(254);

export const signupSchema = z.object({
  companyName: z.string().trim().min(2, 'Company name is required').max(100),
  name: z.string().trim().min(1, 'Name is required').max(100),
  email: emailSchema,
  password: passwordSchema,
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(128),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenantId: string | null;
}

export interface AuthResponse {
  accessToken: string;
  user: AuthUser;
}
