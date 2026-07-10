import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // Server
  PORT: z.string().default('3001'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),

  // Directus
  DIRECTUS_URL: z.string().url(),
  DIRECTUS_TOKEN: z.string().min(1),

  // Redis
  REDIS_URL: z.string().min(1),

  // MinIO
  MINIO_ENDPOINT: z.string().min(1),
  MINIO_PORT: z.string().default('9000'),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET: z.string().default('social-super-server'),
  MINIO_USE_SSL: z.string().default('false'),

  // AI
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),

  // Email
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().optional(),
  ADMIN_EMAIL: z.string().optional(),

  // Theorie sidekick (Miles bromfiets-examen)
  MILES_THEORIE_EXAMEN: z.string().default('2026-07-16'),
  THEORIE_REMINDER_TO: z.string().optional(),

  // Moneybird
  MONEYBIRD_API_TOKEN: z.string().optional(),
  MONEYBIRD_ADMINISTRATION_ID: z.string().optional(),
  // IJs heeft een eigen Moneybird-administratie (299278260688127925)
  IJS_MONEYBIRD_API_TOKEN: z.string().optional(),
  IJS_MONEYBIRD_ADMINISTRATION_ID: z.string().default('299278260688127925'),

  // Google Search Console (service-account JSON als 1 regel)
  GSC_SERVICE_ACCOUNT_JSON: z.string().optional(),

  // API & Webhooks
  API_KEY: z.string().optional(),
  WEBHOOK_API_KEY: z.string().optional(),

  // Meta
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_REDIRECT_URI: z.string().optional(),

  // LinkedIn
  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),
  LINKEDIN_REDIRECT_URI: z.string().optional(),

  // TikTok
  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  TIKTOK_REDIRECT_URI: z.string().optional(),

  // Logging
  LOG_LEVEL: z.string().default('info'),

  // ============================================
  // Email AI Agent — IJs uit de Polder
  // All optional. Agent doet niets tot IJS_EMAIL_AGENT_ENABLED=true.
  // ============================================
  IJS_EMAIL_AGENT_ENABLED: z.string().default('false'),
  IJS_EMAIL_BEDRIJF_ID: z.string().default('7'),
  IJS_INBOX_USER: z.string().default('info@ijsuitdepolder.nl'),
  IJS_INBOX_PASSWORD: z.string().optional(),
  IJS_IMAP_HOST: z.string().default('imap.transip.email'),
  IJS_IMAP_PORT: z.string().default('993'),
  IJS_IMAP_TLS: z.string().default('true'),
  IJS_IMAP_INBOX_MAILBOX: z.string().default('INBOX'),
  IJS_IMAP_SENT_MAILBOX: z.string().default('Sent'),
  IJS_SMTP_HOST: z.string().default('smtp.transip.email'),
  IJS_SMTP_PORT: z.string().default('587'),
  IJS_SMTP_SECURE: z.string().default('false'),
  IJS_FROM_NAME: z.string().default('IJs uit de Polder'),
  IJS_REPLY_AUTO_SEND: z.string().default('hybrid'),
  IJS_REPLY_AUTO_CATEGORIES: z.string().default('availability,info,pricing'),
  IJS_POLL_LOOKBACK_HOURS: z.string().default('24'),
  IJS_SIGNATURE: z.string().optional(),
  IJS_SIGNATURE_HTML: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    console.error(result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
