import { Resend } from 'resend';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
const FROM_EMAIL = env.RESEND_FROM_EMAIL || 'noreply@ipaudio.nl';

interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
}

/**
 * Generic email sending function using Resend
 */
export async function sendEmail(options: SendEmailOptions): Promise<void> {
  if (!resend) {
    logger.warn('Resend API not configured, skipping email');
    return;
  }

  try {
    await resend.emails.send({
      from: options.from || FROM_EMAIL,
      to: Array.isArray(options.to) ? options.to : [options.to],
      subject: options.subject,
      html: options.html
    });

    logger.info(`Email sent: ${options.subject} to ${options.to}`);
  } catch (error: any) {
    logger.error('Failed to send email:', error.message);
    throw error;
  }
}

logger.info('✅ Resend Email Client initialized');
