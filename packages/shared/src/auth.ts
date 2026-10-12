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

export const updateProfileSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

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

export const ASSIGNABLE_ROLES = ['ADMIN', 'PLANNER', 'VIEWER'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const createInviteSchema = z.object({
  email: emailSchema,
  role: z.enum(ASSIGNABLE_ROLES),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(10).max(200),
  name: z.string().trim().min(1, 'Name is required').max(100),
  password: passwordSchema,
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

export const updateUserSchema = z
  .object({
    role: z.enum(ASSIGNABLE_ROLES).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.isActive !== undefined, 'Nothing to update');
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(10).max(200),
  newPassword: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const transferOwnershipSchema = z.object({
  userId: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;

export interface TeamUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  createdAt: string;
}

export interface TeamInvite {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
  expired: boolean;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
