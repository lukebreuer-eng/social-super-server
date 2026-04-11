import { Resend } from 'resend';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { Bedrijf, Post, Lead, directus } from '../config/directus';
import { createItem } from '@directus/sdk';

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
const FROM_EMAIL = env.RESEND_FROM_EMAIL || 'Luke Breuer <luke@ipvoicegroup.com>';

async function logLeadActivity(leadId: number, type: string, description: string, status: string = 'completed', scheduledAt?: string) {
  try {
    await directus.request(createItem('Lead_Activity', {
      lead_id: leadId,
      type,
      description,
      status,
      scheduled_at: scheduledAt || null,
      completed_at: status === 'completed' ? new Date().toISOString() : null,
    }));
  } catch (e) {
    logger.warn(`Failed to log lead activity: ${type}`, e);
  }
}

function getRecipient(bedrijf?: Bedrijf): string[] {
  const email = bedrijf?.notification_email || env.NOTIFICATION_EMAIL || 'luke@ipvoicegroup.nl';
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

  // Parse check answers from bron_url query params
  let checkAnswers = '';
  try {
    const url = new URL(lead.bron_url || 'https://x.com');
    const werkplekken = url.searchParams.get('werkplekken');
    const teams = url.searchParams.get('teams');
    const ai = url.searchParams.get('ai');
    const campaign = url.searchParams.get('utm_campaign') || lead.utm_campaign || '';
    if (werkplekken || teams || ai) {
      checkAnswers = `
        <tr><td colspan="2" style="padding: 12px 8px 4px; border-bottom: none;"><strong style="color: #16b3f0; font-size: 15px;">📋 AI-Readiness Check Antwoorden</strong></td></tr>
        ${werkplekken ? `<tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Werkplekken:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${werkplekken}</td></tr>` : ''}
        ${teams ? `<tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Microsoft Teams:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${teams === 'ja' ? 'Ja, dagelijks' : teams === 'beetje' ? 'Ja, beperkt' : teams === 'planning' ? 'Op de planning' : 'Nee'}</td></tr>` : ''}
        ${ai ? `<tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>AI-notulering testen:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${ai === 'ja_graag' ? '✅ Ja, graag!' : ai === 'nieuwsgierig' ? '🤔 Nieuwsgierig' : 'Wil meer info'}</td></tr>` : ''}
      `;
    }
  } catch {}

  // Determine campaign/product from UTM or bron_url
  let campaignLabel = 'Onbekend';
  if (lead.bron_url?.includes('intermedia-elevate')) campaignLabel = '🚀 Intermedia Elevate — AI-Readiness Check';
  else if (lead.bron_url?.includes('telecom-scan')) campaignLabel = '📞 Telecom Scan';
  else if (lead.utm_campaign) campaignLabel = lead.utm_campaign;

  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: `🎯 [${bedrijf.title}] Nieuwe ${lead.lead_temperature} lead: ${lead.naam}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #003366, #004a80); padding: 20px 24px; border-radius: 12px 12px 0 0;">
          <h2 style="color: #fff; margin: 0 0 8px;">Nieuwe Lead</h2>
          <div style="display: inline-block; background: ${tempColor}; color: white; padding: 4px 12px; border-radius: 12px; font-size: 14px;">
            ${lead.lead_temperature.toUpperCase()} (Score: ${lead.lead_score})
          </div>
        </div>
        <div style="padding: 24px; background: #fff; border: 1px solid #eee; border-top: none; border-radius: 0 0 12px 12px;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Campagne:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: 700; color: #16b3f0;">${campaignLabel}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Naam:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${lead.naam}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Email:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;"><a href="mailto:${lead.email}" style="color:#16b3f0">${lead.email}</a></td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Telefoon:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${lead.telefoon ? `<a href="tel:${lead.telefoon}" style="color:#16b3f0">${lead.telefoon}</a>` : '-'}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Bedrijf:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${lead.bedrijf_naam || '-'}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Bron:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${lead.bron}</td></tr>
          ${checkAnswers}
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
  await logLeadActivity(lead.id, 'lead_received', `Nieuwe ${lead.lead_temperature} lead binnengekomen via ${lead.bron}`);

  // Create a task to call within 48 hours
  try {
    const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString().split('T')[0];
    await directus.request(createItem('Tasks', {
      title: `📞 Bel ${lead.naam} — ${lead.lead_temperature} lead`,
      description: `Email: ${lead.email}\nTelefoon: ${lead.telefoon || 'niet opgegeven'}\nBedrijf: ${lead.bedrijf_naam || '-'}\nBron: ${lead.bron_url || lead.bron}\n\nBelofte: binnen 48 uur bellen.`,
      bedrijf: lead.bedrijf,
      status: 'open',
      priority: lead.lead_temperature === 'hot' ? 'urgent' : 'high',
      category: 'campaign',
      assigned_to: 'Luke',
      due_date: deadline,
    }));
    logger.info(`Task created: call ${lead.naam} by ${deadline}`);
  } catch (e) {
    logger.warn('Failed to create call task for lead:', e);
  }

  // Send a second notification with .ics calendar invite
  try {
    const callTime = new Date(Date.now() + 24 * 60 * 60 * 1000); // tomorrow
    callTime.setHours(10, 0, 0, 0); // 10:00
    const endTime = new Date(callTime.getTime() + 15 * 60 * 1000); // 15 min
    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    const icsContent = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Social Super Server//Lead Follow-up//NL',
      'BEGIN:VEVENT',
      `DTSTART:${fmt(callTime)}`,
      `DTEND:${fmt(endTime)}`,
      `SUMMARY:📞 Bel ${lead.naam} — ${lead.lead_temperature} lead`,
      `DESCRIPTION:Lead: ${lead.naam}\\nEmail: ${lead.email}\\nTelefoon: ${lead.telefoon || '-'}\\nBedrijf: ${lead.bedrijf_naam || '-'}\\nBelofte: binnen 48 uur bellen`,
      `LOCATION:Telefoon`,
      'STATUS:CONFIRMED',
      `ORGANIZER;CN=Luke Breuer:mailto:luke@ipvoicegroup.com`,
      `UID:lead-${lead.id}-${Date.now()}@ipvoicegroup.com`,
      'BEGIN:VALARM',
      'TRIGGER:-PT30M',
      'ACTION:DISPLAY',
      `DESCRIPTION:Bel ${lead.naam} over 30 minuten`,
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: `📅 Agenda: Bel ${lead.naam} morgen 10:00`,
      html: `<p>Hi Luke,</p><p>Open de bijlage om het belmoment met <strong>${lead.naam}</strong> in je agenda te zetten.</p><p>${lead.telefoon ? `<a href="tel:${lead.telefoon}">📞 ${lead.telefoon}</a>` : `📧 ${lead.email}`}</p>`,
      attachments: [{
        filename: `bel-${lead.naam.replace(/\s+/g, '-').toLowerCase()}.ics`,
        content: Buffer.from(icsContent).toString('base64'),
        contentType: 'text/calendar',
      }],
    });
    logger.info(`Calendar invite sent for lead ${lead.naam}`);
  } catch (e) {
    logger.warn('Failed to send calendar invite:', e);
  }
  await logLeadActivity(lead.id, 'admin_notified', `Notificatie verstuurd naar ${to.join(', ')}`);

  // Schedule follow-up emails
  const day3 = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const day7 = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await logLeadActivity(lead.id, 'followup_day3', 'Opvolgmail dag 3: tip + waarde', 'scheduled', day3);
  await logLeadActivity(lead.id, 'followup_day7', 'Opvolgmail dag 7: gesprek plannen?', 'scheduled', day7);

  // Send confirmation email to the lead themselves
  if (lead.email) {
    try {
      await resend.emails.send({
        from: FROM_EMAIL,
        to: [lead.email],
        subject: `Bedankt voor je aanvraag — IP Voice Group`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
            <div style="background: linear-gradient(135deg, #003366, #004a80); padding: 32px; border-radius: 12px 12px 0 0; text-align: center;">
              <h1 style="color: #fff; margin: 0; font-size: 22px;">Bedankt voor je interesse!</h1>
            </div>
            <div style="padding: 32px; background: #fff; border: 1px solid #eee; border-top: none; border-radius: 0 0 12px 12px;">
              <p>Hoi ${lead.naam.split(' ')[0]},</p>
              <p>Leuk dat je de AI-Readiness Check hebt ingevuld! Ik heb je gegevens ontvangen en ga er persoonlijk mee aan de slag.</p>
              <p><strong>Wat gebeurt er nu?</strong></p>
              <p>Hier is alvast je <strong>AI-Readiness Check</strong>:</p>
              <p style="text-align: center; margin: 20px 0;">
                <a href="https://ipvoicegroup.com/wp-content/uploads/2026/04/AI-Readiness-Check-2026.pdf" style="background: #003366; color: #fff; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 700; display: inline-block;">
                  📋 Download de AI-Readiness Check (PDF)
                </a>
              </p>
              <p>📞 Ik bel je binnen 48 uur om de resultaten persoonlijk door te nemen — kort, eerlijk en zonder verkooppraatjes.</p>
              <p>In dat gesprek laat ik je in 10 minuten zien:</p>
              <ul style="color: #555; line-height: 1.8;">
                <li>Waar jouw communicatie nu staat</li>
                <li>Wat AI concreet voor jouw situatie kan betekenen</li>
                <li>Of Intermedia Elevate een goede match is (en als het dat niet is, zeg ik dat ook)</li>
              </ul>
              <p>Kan je niet wachten? Bel me gerust:</p>
              <p style="text-align: center; margin: 24px 0;">
                <a href="tel:0880405858" style="background: #16b3f0; color: #fff; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 700; display: inline-block;">
                  📞 088 040 58 58
                </a>
              </p>
              <p>Groet,</p>
              <p><strong>Luke Breuer</strong><br>
              IP Voice Group<br>
              <span style="color: #888;">ISO 27001 gecertificeerd | Intermedia Elevate Partner</span></p>
            </div>
          </div>
        `,
      });
      logger.info(`Lead confirmation email sent to ${lead.email}`);
      await logLeadActivity(lead.id, 'confirmation_sent', `Bevestigingsmail + PDF verstuurd naar ${lead.email}`);
    } catch (error) {
      logger.warn(`Failed to send lead confirmation to ${lead.email}:`, error);
    }
  }
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
