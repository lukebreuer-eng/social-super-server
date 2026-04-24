import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';

const MONEYBIRD_API_URL = 'https://moneybird.com/api/v2';

// TODO: Luke - vul deze in via environment variables
const ADMINISTRATION_ID = process.env.MONEYBIRD_ADMINISTRATION_ID || '';
const API_TOKEN = process.env.MONEYBIRD_API_TOKEN || '';

interface MoneybirdContact {
  id: string;
  company_name: string;
  firstname: string;
  lastname?: string;
  email: string;
  phone: string;
  customer_id?: string;
}

interface MoneybirdQuoteDetails {
  description: string;
  price: string;
  amount: string;
  tax_rate_id?: string;
  ledger_account_id?: string;
}

interface MoneybirdQuote {
  id: string;
  quote_id: string;
  contact_id: string;
  quote_date: string;
  total_price_excl_tax: string;
  total_price_incl_tax: string;
  url: string;
  pdf_url: string;
}

export class MoneybirdAPI {
  private axios: AxiosInstance;

  constructor() {
    if (!ADMINISTRATION_ID || !API_TOKEN) {
      throw new Error('Moneybird API credentials not configured');
    }

    this.axios = axios.create({
      baseURL: `${MONEYBIRD_API_URL}/${ADMINISTRATION_ID}`,
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    logger.info('Moneybird API initialized');
  }

  /**
   * Create or update contact in Moneybird
   */
  async createContact(data: {
    company_name: string;
    firstname: string;
    lastname?: string;
    email: string;
    phone: string;
  }): Promise<MoneybirdContact> {
    try {
      // First check if contact exists by email
      const existingContact = await this.findContactByEmail(data.email);

      if (existingContact) {
        logger.info(`Moneybird contact already exists: ${existingContact.id}`);
        return existingContact;
      }

      // Create new contact
      const response = await this.axios.post('/contacts', {
        contact: {
          company_name: data.company_name,
          firstname: data.firstname,
          lastname: data.lastname || '',
          email: data.email,
          phone: data.phone,
          send_invoices_to_email: data.email,
          send_estimates_to_email: data.email
        }
      });

      logger.info(`Moneybird contact created: ${response.data.id}`);
      return response.data as MoneybirdContact;

    } catch (error: any) {
      logger.error('Moneybird createContact error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Find contact by email
   */
  private async findContactByEmail(email: string): Promise<MoneybirdContact | null> {
    try {
      const response = await this.axios.get('/contacts', {
        params: { query: email }
      });

      const contacts = response.data;
      if (contacts && contacts.length > 0) {
        // Find exact email match
        const match = contacts.find((c: any) => c.email === email);
        return match || null;
      }

      return null;
    } catch (error) {
      logger.warn('Moneybird findContactByEmail error:', error);
      return null;
    }
  }

  /**
   * Create internet product quote
   */
  async createInternetQuote(data: {
    contact_id: string;
    bandwidth: string;
    quality: string;
    price: number;
    is_bundel: boolean;
    bundel_users?: number;
    postcode?: string;
    huisnummer?: string;
  }): Promise<MoneybirdQuote> {
    try {
      // Build description
      const description = data.is_bundel
        ? `Zakelijk Internet ${data.bandwidth} ${data.quality} DIA + Elevate Telefonie (${data.bundel_users} gebruikers)`
        : `Zakelijk Internet ${data.bandwidth} ${data.quality} DIA`;

      const locationInfo = data.postcode && data.huisnummer
        ? `\nLocatie: ${data.postcode} ${data.huisnummer}`
        : '';

      const details: MoneybirdQuoteDetails[] = [
        {
          description: description + locationInfo,
          price: data.price.toFixed(2),
          amount: '1',
          // BTW hoog 21% (Nederland)
          tax_rate_id: '160907905010238698',
          // Ledger account voor telecom omzet (optioneel - Moneybird gebruikt standaard account)
          // ledger_account_id: 'xxx'
        }
      ];

      // Create sales invoice (Moneybird gebruikt "sales_invoice" voor quotes)
      const response = await this.axios.post('/sales_invoices', {
        sales_invoice: {
          contact_id: data.contact_id,
          invoice_date: new Date().toISOString().split('T')[0],
          // Workflow wordt automatisch bepaald door Moneybird
          // (geen aparte SalesInvoiceWorkflow gevonden in API v2)
          reference: `Internet - ${data.bandwidth} ${data.quality}`,
          details_attributes: details,
          // Optional: custom email message
          // send_method: 'Email'
        }
      });

      const quote = response.data;

      logger.info(`Moneybird quote created: ${quote.id} for contact ${data.contact_id}`);

      return {
        id: quote.id,
        quote_id: quote.invoice_id || quote.id,
        contact_id: data.contact_id,
        quote_date: quote.invoice_date,
        total_price_excl_tax: quote.total_price_excl_tax,
        total_price_incl_tax: quote.total_price_incl_tax,
        url: quote.url,
        pdf_url: quote.url + '.pdf'
      };

    } catch (error: any) {
      logger.error('Moneybird createInternetQuote error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Send quote via email
   */
  async sendQuote(quoteId: string, email: string, customMessage?: string): Promise<void> {
    try {
      const message = customMessage || `Beste klant,

Bijgevoegd treft u de offerte aan voor zakelijk internet van IP Voice Group.

De offerte bevat:
- Dedicated internet connectie (DIA) met SLA
- Symmetrische bandbreedte (upload = download)
- Vaste IP-adressen
- 36 maanden contract met €0 installatiekosten

Heeft u vragen? Neem gerust contact met ons op.

Met vriendelijke groet,
IP Voice Group
https://ipvoicegroup.com
085-0606060`;

      await this.axios.patch(`/sales_invoices/${quoteId}/send_invoice`, {
        sales_invoice_sending: {
          delivery_method: 'Email',
          email_address: email,
          email_message: message
        }
      });

      logger.info(`Moneybird quote ${quoteId} sent to ${email}`);

    } catch (error: any) {
      logger.error('Moneybird sendQuote error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get quote PDF URL
   */
  async getQuotePdfUrl(quoteId: string): Promise<string> {
    try {
      const response = await this.axios.get(`/sales_invoices/${quoteId}`);
      const quote = response.data;

      return quote.url + '.pdf';

    } catch (error: any) {
      logger.error('Moneybird getQuotePdfUrl error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get quote status
   */
  async getQuoteStatus(quoteId: string): Promise<string> {
    try {
      const response = await this.axios.get(`/sales_invoices/${quoteId}`);
      const quote = response.data;

      // States: draft, open, scheduled, pending_payment, late, paid, uncollectible
      return quote.state;

    } catch (error: any) {
      logger.error('Moneybird getQuoteStatus error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Test API connection
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.axios.get('/contacts', { params: { per_page: 1 } });
      logger.info('Moneybird API connection test: OK');
      return true;
    } catch (error) {
      logger.error('Moneybird API connection test: FAILED', error);
      return false;
    }
  }
}

// Export singleton instance
export const moneybirdAPI = new MoneybirdAPI();

logger.info('✅ Moneybird API module loaded');
