import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32, { error: 'SESSION_SECRET must be at least 32 characters' }),
  // Empty (as in .env.example) means unset.
  PLATFORM_SECRET_KEY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(32, { error: 'PLATFORM_SECRET_KEY must be at least 32 characters' }).optional(),
  ),
  APP_URL: z.url(),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  SESSION_REMEMBER_DAYS: z.coerce.number().int().positive().default(30),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  EMAIL_PROVIDER: z.enum(['smtp', 'ses', 'disabled']).default('disabled'),
  EMAIL_FROM: z.string().default('LexForgeX <notifications@lexforgex.local>'),
  SMTP_URL: z.string().default('smtp://localhost:1025'),
  AWS_REGION: z.string().default('ap-south-1'),
  SES_CONFIGURATION_SET: z.string().optional(),
  // Document storage (S3). S3_BUCKET unset: uploads explain that storage isn't set up. In production the EC2 instance role
  // supplies credentials; S3_ENDPOINT, path style and S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY are for a local S3-compatible store (SeaweedFS) in development.
  S3_BUCKET: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(3).optional()),
  S3_REGION: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  S3_ENDPOINT: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
  S3_ACCESS_KEY_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  S3_SECRET_ACCESS_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  REDIS_URL: z.string().default('redis://localhost:6380'),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  SCHEDULER_POLL_MS: z.coerce.number().int().positive().default(15000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.SESSION_SECRET.startsWith('change-me')) {
    throw new Error('SESSION_SECRET must be set to a real secret in production');
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.PLATFORM_SECRET_KEY) {
    throw new Error('PLATFORM_SECRET_KEY must be set in production');
  }
  return parsed.data;
}
