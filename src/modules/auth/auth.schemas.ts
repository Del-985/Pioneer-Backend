import { z } from 'zod';

const passwordSchema = z.string().min(12).max(200);

export const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(10).max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
}).refine((value) => value.currentPassword !== value.newPassword, {
  message: 'The new password must be different from the current password.',
  path: ['newPassword'],
});

export const requestPasswordResetSchema = z.object({
  email: z.string().trim().email().max(254),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(500),
  newPassword: passwordSchema,
});
