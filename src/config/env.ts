import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  SESSION_COOKIE_NAME: z.string().trim().min(1).max(100).default('pioneer_session'),
  SESSION_COOKIE_DOMAIN: z.string().trim().min(1).optional(),
  BOOTSTRAP_ADMIN_EMAIL: z.string().trim().email().optional(),
  BOOTSTRAP_ADMIN_NAME: z.string().trim().min(1).max(120).optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).max(200).optional(),
  SMTP_HOST: z.string().trim().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().max(65535).default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().trim().min(1).max(320).optional(),
  PASSWORD_RESET_URL: z.string().url().optional(),
  NOTIFICATION_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  OBJECT_STORAGE_ENDPOINT: z.string().url().optional(),
  OBJECT_STORAGE_REGION: z.string().trim().min(1).default('auto'),
  OBJECT_STORAGE_BUCKET: z.string().trim().min(1).optional(),
  OBJECT_STORAGE_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
  OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  OBJECT_STORAGE_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  OBJECT_STORAGE_PRESIGN_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
}).superRefine((value, ctx) => {
  if (value.SMTP_HOST && !value.SMTP_FROM) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SMTP_FROM'], message: 'SMTP_FROM is required when SMTP_HOST is configured.' });
  }
  if ((value.SMTP_USER && !value.SMTP_PASSWORD) || (!value.SMTP_USER && value.SMTP_PASSWORD)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SMTP_PASSWORD'], message: 'SMTP_USER and SMTP_PASSWORD must be configured together.' });
  }

  const storageConfigured = Boolean(
    value.OBJECT_STORAGE_ENDPOINT ||
    value.OBJECT_STORAGE_BUCKET ||
    value.OBJECT_STORAGE_ACCESS_KEY_ID ||
    value.OBJECT_STORAGE_SECRET_ACCESS_KEY
  );
  if (storageConfigured) {
    if (!value.OBJECT_STORAGE_BUCKET) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OBJECT_STORAGE_BUCKET'], message: 'OBJECT_STORAGE_BUCKET is required when object storage is configured.' });
    if (!value.OBJECT_STORAGE_ACCESS_KEY_ID) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OBJECT_STORAGE_ACCESS_KEY_ID'], message: 'OBJECT_STORAGE_ACCESS_KEY_ID is required when object storage is configured.' });
    if (!value.OBJECT_STORAGE_SECRET_ACCESS_KEY) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OBJECT_STORAGE_SECRET_ACCESS_KEY'], message: 'OBJECT_STORAGE_SECRET_ACCESS_KEY is required when object storage is configured.' });
  }
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const builtInCorsOrigins = [
  'https://pioneerlegacyworks.com',
  'https://www.pioneerlegacyworks.com',
  'https://pioneeroutdoorservices.com',
  'https://www.pioneeroutdoorservices.com',
  'https://del-985.github.io',
];

export const env = {
  ...parsed.data,
  corsOrigins: Array.from(new Set([
    ...parsed.data.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    ...builtInCorsOrigins,
  ])),
};
