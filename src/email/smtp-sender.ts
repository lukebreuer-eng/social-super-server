import nodemailer, { Transporter } from 'nodemailer';
import { logger } from '../utils/logger';
import { env } from '../config/env';

export interface SmtpAccountConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromEmail: string;
  fromName: string;
}

export interface SendReplyInput {
  to: string;
  cc?: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  inReplyTo?: string;
  references?: string[];
}

export interface SendReplyResult {
  messageId: string;
  rawRfc822: Buffer;
  accepted: string[];
  rejected: string[];
}

export function getIjsSmtpConfig(): SmtpAccountConfig | null {
  if (!env.IJS_INBOX_PASSWORD) return null;
  return {
    host: env.IJS_SMTP_HOST,
    port: parseInt(env.IJS_SMTP_PORT, 10),
    secure: env.IJS_SMTP_SECURE === 'true',
    user: env.IJS_INBOX_USER,
    password: env.IJS_INBOX_PASSWORD,
    fromEmail: env.IJS_INBOX_USER,
    fromName: env.IJS_FROM_NAME,
  };
}

function buildTransport(cfg: SmtpAccountConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: !cfg.secure,
    auth: { user: cfg.user, pass: cfg.password },
  });
}

export async function sendReply(
  cfg: SmtpAccountConfig,
  input: SendReplyInput,
): Promise<SendReplyResult> {
  const transporter = buildTransport(cfg);

  const inReplyToHeader = input.inReplyTo ? `<${input.inReplyTo}>` : undefined;
  const referencesHeader = input.references && input.references.length > 0
    ? input.references.map((r) => `<${r}>`).join(' ')
    : undefined;

  const info = await transporter.sendMail({
    from: { name: cfg.fromName, address: cfg.fromEmail },
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    text: input.textBody,
    html: input.htmlBody,
    inReplyTo: inReplyToHeader,
    references: referencesHeader,
  });

  logger.info(`SMTP reply sent: ${info.messageId} → ${input.to} (accepted=${info.accepted?.length ?? 0})`);

  return {
    messageId: (info.messageId || '').replace(/^<|>$/g, ''),
    rawRfc822: Buffer.from(info.response || ''),
    accepted: (info.accepted || []).map((a: any) => (typeof a === 'string' ? a : a.address)),
    rejected: (info.rejected || []).map((a: any) => (typeof a === 'string' ? a : a.address)),
  };
}

/**
 * Bouwt een RFC 5322 bericht zonder te versturen — handig om in de IMAP Sent
 * folder te kunnen APPEND-en (de SMTP server geeft de raw mail vaak niet terug).
 */
export async function buildRfc822(
  cfg: SmtpAccountConfig,
  input: SendReplyInput,
  messageId: string,
): Promise<Buffer> {
  const inReplyToHeader = input.inReplyTo ? `<${input.inReplyTo}>` : undefined;
  const referencesHeader = input.references && input.references.length > 0
    ? input.references.map((r) => `<${r}>`).join(' ')
    : undefined;

  // nodemailer ships MailComposer als interne module
  const MailComposer = (await import('nodemailer/lib/mail-composer')).default;
  const composer = new MailComposer({
    from: { name: cfg.fromName, address: cfg.fromEmail },
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    text: input.textBody,
    html: input.htmlBody,
    messageId: `<${messageId}>`,
    inReplyTo: inReplyToHeader,
    references: referencesHeader,
  } as any);

  return new Promise<Buffer>((resolve, reject) => {
    composer.compile().build((err, message) => {
      if (err) return reject(err);
      resolve(message);
    });
  });
}

export async function testSmtpConnection(cfg: SmtpAccountConfig): Promise<{ ok: boolean; error?: string }> {
  const transporter = buildTransport(cfg);
  try {
    await transporter.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
