import { directus } from '../config/directus';
import { readItems, updateItem } from '@directus/sdk';
import { moneybirdAPI } from '../integrations/moneybird-api';
import { processLead } from './lead-scorer';
import { logger } from '../utils/logger';
import { sendEmail } from '../email/resend-client';

interface InternetLead {
  id: number;
  naam: string;
  email: string;
  telefoon: string;
  bedrijf_naam: string;
  lead_score: number;
  lead_temperature: string;
  status: string;
}

interface InternetProduct {
  id: number;
  lead: number;
  bandwidth: string;
  quality: string;
  retail_price: number;
  wholesale_cost: number;
  margin: number;
  is_bundel: boolean;
  bundel_users: number;
  postcode: string;
  huisnummer: string;
  netcode_name: string;
  zone: string;
  status: string;
}

/**
 * Handle new internet lead from WordPress
 */
export async function handleInternetLead(leadId: number): Promise<void> {
  try {
    logger.info(`🌐 Processing internet lead ${leadId}...`);

    // Step 1: Score the lead
    const scoreResult = await processLead(leadId);

    logger.info(`Internet lead ${leadId} scored: ${scoreResult.score} (${scoreResult.temperature})`);

    // Step 2: If hot lead (≥70), create Moneybird quote automatically
    if (scoreResult.score >= 70) {
      await createMoneybirdQuoteForLead(leadId);
    } else if (scoreResult.score >= 40) {
      // Warm lead - send notification to admin
      await notifyAdminOfWarmLead(leadId);
    } else {
      // Cold lead - just log it
      logger.info(`Cold lead ${leadId} - no immediate action needed`);
    }

  } catch (error: any) {
    logger.error(`Error handling internet lead ${leadId}:`, error.message);
    throw error;
  }
}

/**
 * Create Moneybird quote for hot lead
 */
async function createMoneybirdQuoteForLead(leadId: number): Promise<void> {
  try {
    logger.info(`🔥 Hot lead detected! Creating Moneybird quote for lead ${leadId}...`);

    // Fetch lead with related internet product
    const leads = await directus.request(
      readItems('Leads', {
        filter: { id: { _eq: leadId } },
        limit: 1
      })
    ) as InternetLead[];

    if (!leads || leads.length === 0) {
      throw new Error(`Lead ${leadId} not found`);
    }

    const lead = leads[0];

    // Fetch internet product
    const products = await directus.request(
      readItems('Internet_Products', {
        filter: { lead: { _eq: leadId } },
        limit: 1
      })
    ) as InternetProduct[];

    if (!products || products.length === 0) {
      logger.warn(`No internet product found for lead ${leadId}`);
      return;
    }

    const product = products[0];

    // Step 1: Create or get Moneybird contact
    const contact = await moneybirdAPI.createContact({
      company_name: lead.bedrijf_naam || lead.naam,
      firstname: lead.naam.split(' ')[0] || lead.naam,
      lastname: lead.naam.split(' ').slice(1).join(' ') || '',
      email: lead.email,
      phone: lead.telefoon
    });

    // Step 2: Create quote
    const quote = await moneybirdAPI.createInternetQuote({
      contact_id: contact.id,
      bandwidth: product.bandwidth,
      quality: product.quality,
      price: product.retail_price,
      is_bundel: product.is_bundel,
      bundel_users: product.bundel_users,
      postcode: product.postcode,
      huisnummer: product.huisnummer
    });

    // Step 3: Send quote via email
    await moneybirdAPI.sendQuote(quote.id, lead.email);

    // Step 4: Update lead status in Directus
    await directus.request(
      updateItem('Leads', leadId, {
        status: 'quoted'
      })
    );

    // Step 5: Update product status and link Moneybird quote
    await directus.request(
      updateItem('Internet_Products', product.id, {
        moneybird_quote_id: quote.quote_id,
        status: 'quoted'
      })
    );

    // Step 6: Notify admin
    await notifyAdminOfQuoteCreated(lead, product, quote);

    logger.info(`✅ Moneybird quote ${quote.quote_id} created and sent for lead ${leadId}`);

  } catch (error: any) {
    logger.error(`Error creating Moneybird quote for lead ${leadId}:`, error.message);

    // Update lead with error status
    try {
      await directus.request(
        updateItem('Leads', leadId, {
          status: 'quote_failed',
          notities: `Moneybird quote creation failed: ${error.message}`
        })
      );
    } catch (updateError) {
      logger.error('Failed to update lead status after quote error', updateError);
    }

    throw error;
  }
}

/**
 * Notify admin of hot lead with quote created
 */
async function notifyAdminOfQuoteCreated(
  lead: InternetLead,
  product: InternetProduct,
  quote: { quote_id: string; pdf_url: string }
): Promise<void> {
  try {
    const emailHtml = `
      <h2>🔥 Hot Lead - Automatische Offerte Verstuurd!</h2>

      <p>Een hot lead (score: ${lead.lead_score}) heeft een internetproduct aangevraagd en er is automatisch een Moneybird offerte aangemaakt en verstuurd.</p>

      <h3>Lead Details</h3>
      <ul>
        <li><strong>Naam:</strong> ${lead.naam}</li>
        <li><strong>Bedrijf:</strong> ${lead.bedrijf_naam}</li>
        <li><strong>Email:</strong> ${lead.email}</li>
        <li><strong>Telefoon:</strong> ${lead.telefoon}</li>
        <li><strong>Lead Score:</strong> ${lead.lead_score} (${lead.lead_temperature})</li>
      </ul>

      <h3>Product</h3>
      <ul>
        <li><strong>Bandwidth:</strong> ${product.bandwidth}</li>
        <li><strong>Kwaliteit:</strong> ${product.quality}</li>
        <li><strong>Prijs:</strong> €${product.retail_price}/maand</li>
        <li><strong>Marge:</strong> €${product.margin}/maand</li>
        ${product.is_bundel ? `<li><strong>Bundel:</strong> Ja (${product.bundel_users} users)</li>` : ''}
        <li><strong>Locatie:</strong> ${product.postcode} ${product.huisnummer}</li>
        <li><strong>Netcode:</strong> ${product.netcode_name} (Zone ${product.zone})</li>
      </ul>

      <h3>Moneybird Offerte</h3>
      <ul>
        <li><strong>Offerte ID:</strong> ${quote.quote_id}</li>
        <li><strong>Status:</strong> Verstuurd naar ${lead.email}</li>
      </ul>

      <p><strong>⏭️ Volgende stappen:</strong></p>
      <ol>
        <li>Klant ontvangt offerte automatisch</li>
        <li>Bel klant binnen 24 uur voor follow-up</li>
        <li>Check Moneybird voor acceptatie status</li>
      </ol>

      <p>
        <a href="https://admin.ipaudio.nl/admin/content/Leads/${lead.id}" style="display: inline-block; background: #667eea; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-right: 10px;">
          Bekijk Lead in Directus
        </a>
        <a href="https://moneybird.com/${process.env.MONEYBIRD_ADMINISTRATION_ID}/sales_invoices/${quote.quote_id}" style="display: inline-block; background: #4caf50; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
          Bekijk Offerte in Moneybird
        </a>
      </p>
    `;

    await sendEmail({
      to: process.env.ADMIN_EMAIL || 'sales@ipvoicegroup.com',
      subject: `🔥 Hot Lead + Automatische Offerte - ${lead.bedrijf_naam}`,
      html: emailHtml
    });

    logger.info(`Admin notified of quote creation for lead ${lead.id}`);

  } catch (error) {
    logger.error('Failed to send admin notification:', error);
    // Non-critical error - don't throw
  }
}

/**
 * Notify admin of warm lead (manual follow-up needed)
 */
async function notifyAdminOfWarmLead(leadId: number): Promise<void> {
  try {
    const leads = await directus.request(
      readItems('Leads', {
        filter: { id: { _eq: leadId } },
        limit: 1
      })
    ) as InternetLead[];

    if (!leads || leads.length === 0) return;

    const lead = leads[0];

    const emailHtml = `
      <h2>🌡️ Warm Lead - Follow-up Nodig</h2>

      <p>Een warm lead (score: ${lead.lead_score}) heeft internet aangevraagd. Handmatige follow-up nodig.</p>

      <h3>Lead Details</h3>
      <ul>
        <li><strong>Naam:</strong> ${lead.naam}</li>
        <li><strong>Bedrijf:</strong> ${lead.bedrijf_naam}</li>
        <li><strong>Email:</strong> ${lead.email}</li>
        <li><strong>Telefoon:</strong> ${lead.telefoon}</li>
        <li><strong>Lead Score:</strong> ${lead.lead_score} (${lead.lead_temperature})</li>
      </ul>

      <p><strong>⏭️ Actie vereist:</strong> Bel klant voor kwalificatie en maak handmatig offerte in Moneybird.</p>

      <p>
        <a href="https://admin.ipaudio.nl/admin/content/Leads/${lead.id}" style="display: inline-block; background: #667eea; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
          Bekijk Lead in Directus
        </a>
      </p>
    `;

    await sendEmail({
      to: process.env.ADMIN_EMAIL || 'sales@ipvoicegroup.com',
      subject: `🌡️ Warm Lead - Follow-up Nodig - ${lead.bedrijf_naam}`,
      html: emailHtml
    });

    logger.info(`Admin notified of warm lead ${leadId}`);

  } catch (error) {
    logger.error('Failed to send warm lead notification:', error);
    // Non-critical error - don't throw
  }
}

/**
 * Get internet lead statistics
 */
export async function getInternetLeadStatistics(): Promise<any> {
  try {
    const leads = await directus.request(
      readItems('Leads', {
        filter: { product_type: { _eq: 'internet' } }
      })
    ) as InternetLead[];

    const total = leads.length;
    const hot = leads.filter(l => l.lead_temperature === 'hot').length;
    const warm = leads.filter(l => l.lead_temperature === 'warm').length;
    const cold = leads.filter(l => l.lead_temperature === 'cold').length;
    const quoted = leads.filter(l => l.status === 'quoted').length;
    const converted = leads.filter(l => l.status === 'converted').length;

    return {
      total,
      hot,
      warm,
      cold,
      quoted,
      converted,
      conversion_rate: total > 0 ? (converted / total * 100).toFixed(1) + '%' : '0%'
    };

  } catch (error) {
    logger.error('Error getting internet lead statistics:', error);
    return null;
  }
}

logger.info('✅ Internet Lead Handler initialized');
