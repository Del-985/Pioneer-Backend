import { z } from 'zod';

export const createUserSchema = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(2).max(120),
  password: z.string().min(12).max(200),
  initialAssignment: z.object({
    roleId: z.string().uuid(),
    legalEntityId: z.string().uuid().optional(),
    businessUnitId: z.string().uuid().optional(),
  }).optional(),
});

export const updateUserSchema = z.object({
  email: z.string().trim().email().max(254).optional(),
  displayName: z.string().trim().min(2).max(120).optional(),
  status: z.enum(['active', 'disabled']).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field must be supplied.',
});

export const createRoleAssignmentSchema = z.object({
  roleId: z.string().uuid(),
  legalEntityId: z.string().uuid().optional(),
  businessUnitId: z.string().uuid().optional(),
});
