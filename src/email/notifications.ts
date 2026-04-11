import { Resend } from 'resend';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { Bedrijf, Post, Lead } from '../config/directus';

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
const FROM_EMAIL = env.RESEND_FROM_EMAIL || 'Luke Breuer <luke@ipvoicegroup.com>';

function getRecipient(bedrijf?: Bedrijf): string[] {
  const email = bedrijf?.notification_email || env.NOTIFICATION_EMAIL;
  if (!email) {
    logger.warn('No notification email configured (set NOTIFICATION_EMAIL or bedrijf.notification_email)');
    return [];
  }
  return [email];
}

// ============================================
// Email Notifications
// ============================================

export async function sendPostReadyForReview(post: Post, bedrijf: Bedrijf): Promise<void> {
  if (!resend) {
    logger.warn('Email not configured, skipping notification');
    return;
  }

  const to = getRecipient(bedrijf);
  if (to.length === 0) return;

  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `[${bedrijf.title}] Nieuwe post klaar voor review`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a2e;">Nieuwe post klaar voor review</h2>
        <p><strong>Bedrijf:</strong> ${bedrijf.title}</p>
        <p><strong>Titel:</strong> ${post.title}</p>
        <p><strong>AI Confidence:</strong> ${Math.round((post.ai_confidence_score || 0) * 100)}%</p>
        <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
          <p style="white-space: pre-wrap;">${post.caption}</p>
        </div>
        <p>
          <a href="${env.DIRECTUS_URL}/admin/content/Posts/${post.id}"
             style="background: #1a1a2e; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Review in Directus
          </a>
        </p>
      </div>
    `,
  });

  logger.info(`Review notification sent for post ${post.id}`);
}

export async function sendNewLeadNotification(lead: Lead, bedrijf: Bedrijf): Promise<void> {
  if (!resend) return;

  const to = getRecipient(bedrijf);
  if (to.length === 0) return;

  const tempColors: Record<string, string> = {
    hot: '#e74c3c',
    warm: '#f39c12',
    cold: '#3498db',
  };

  const tempColor = tempColors[lead.lead_temperature] || '#95a5a6';

  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `[${bedrijf.title}] Nieuwe ${lead.lead_temperature} lead: ${lead.naam}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a2e;">Nieuwe Lead</h2>
        <div style="display: inline-block; background: ${tempColor}; color: white; padding: 4px 12px; border-radius: 12px; font-size: 14px; margin-bottom: 16px;">
          ${lead.lead_temperature.toUpperCase()} (Score: ${lead.lead_score})
        </div>
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Naam:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${lead.naam}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Email:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${lead.email}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Telefoon:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${lead.telefoon || '-'}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Bedrijf:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${lead.bedrijf_naam || '-'}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Bron:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${lead.bron}</td></tr>
          <tr><td style="padding: 8px;"><strong>URL:</strong></td><td style="padding: 8px;">${lead.bron_url || '-'}</td></tr>
        </table>
        <p style="margin-top: 16px;">
          <a href="${env.DIRECTUS_URL}/admin/content/Leads/${lead.id}"
             style="background: #1a1a2e; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Bekijk in Directus
          </a>
        </p>
      </div>
    `,
  });

  logger.info(`Lead notification sent for ${lead.naam} (${lead.lead_temperature})`);
}

export async function sendWeeklyDigest(
  bedrijfTitle: string,
  stats: { posts: number; leads: number; engagement: number; topPost: string }
): Promise<void> {
  if (!resend) return;

  const to = getRecipient();
  if (to.length === 0) return;

  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `[${bedrijfTitle}] Wekelijkse samenvatting`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a2e;">Wekelijkse Samenvatting - ${bedrijfTitle}</h2>
        <div style="display: flex; gap: 16px; margin: 24px 0;">
          <div style="flex: 1; background: #e8f4f8; padding: 16px; border-radius: 8px; text-align: center;">
            <div style="font-size: 32px; font-weight: bold; color: #1a1a2e;">${stats.posts}</div>
            <div style="color: #666;">Posts gepubliceerd</div>
          </div>
          <div style="flex: 1; background: #e8f8e8; padding: 16px; border-radius: 8px; text-align: center;">
            <div style="font-size: 32px; font-weight: bold; color: #1a1a2e;">${stats.leads}</div>
            <div style="color: #666;">Nieuwe leads</div>
          </div>
          <div style="flex: 1; background: #f8e8f4; padding: 16px; border-radius: 8px; text-align: center;">
            <div style="font-size: 32px; font-weight: bold; color: #1a1a2e;">${stats.engagement}</div>
            <div style="color: #666;">Engagement</div>
          </div>
        </div>
        ${stats.topPost ? `<p><strong>Top post:</strong> ${stats.topPost}</p>` : ''}
        <p>
          <a href="${env.DIRECTUS_URL}/admin/insights"
             style="background: #1a1a2e; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            Bekijk Dashboard
          </a>
        </p>
      </div>
    `,
  });

  logger.info(`Weekly digest sent for ${bedrijfTitle}`);
}

logger.info('✅ Email Notifications initialized');
