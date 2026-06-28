/**
 * Offerte-sync: haalt IJs-offertes (Moneybird estimates) op en houdt de Boekingen
 * actueel, met het offertenummer erbij. Dedup op de stabiele Moneybird-id, zodat
 * herhaald draaien veilig is en nieuwe getekende offertes vanzelf binnenkomen.
 *
 * Bewaart handmatig ingevulde event-velden (event_datum, event_type, locatie,
 * bemensing, titel); die overschrijft de sync niet.
 */

import axios from 'axios';
import { directus } from '../config/directus';
import { readItems, createItem, updateItem } from '@directus/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';

function ijsToken(): string | null {
  return env.IJS_MONEYBIRD_API_TOKEN || null;
}
const ADMIN = () => env.IJS_MONEYBIRD_ADMINISTRATION_ID || '299278260688127925';

// Moneybird estimate state -> onze status
function mapStatus(state: string): string {
  switch (String(state || '').toLowerCase()) {
    case 'accepted':
    case 'billed': return 'gewonnen';
    case 'open':
    case 'pending': return 'open';
    case 'late': return 'verlopen';
    case 'declined':
    case 'rejected': return 'afgewezen';
    default: return 'concept';
  }
}

export interface OfferteSyncResult { opgehaald: number; nieuw: number; bijgewerkt: number; gewonnen: number; }

export async function syncOffertes(bedrijfId: number): Promise<OfferteSyncResult> {
  const token = ijsToken();
  if (!token) throw new Error('IJS_MONEYBIRD_API_TOKEN ontbreekt');
  const base = `https://moneybird.com/api/v2/${ADMIN()}`;
  const headers = { Authorization: `Bearer ${token}` };

  // haal estimates op over de afgelopen jaren (alle states), gepagineerd
  const estimates: any[] = [];
  const huidigJaar = new Date().getFullYear();
  for (let jaar = huidigJaar - 1; jaar <= huidigJaar; jaar++) {
    for (let page = 1; page <= 10; page++) {
      const url = `${base}/estimates.json?filter=period:${jaar}01..${jaar}12&per_page=100&page=${page}`;
      const { data } = await axios.get(url, { headers });
      if (!Array.isArray(data) || data.length === 0) break;
      estimates.push(...data);
      if (data.length < 100) break;
    }
  }

  // bestaande boekingen op moneybird_estimate_id
  const bestaand = (await directus.request(readItems('Boekingen', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 }))) as any[];
  const byMbId = new Map<string, any>();
  for (const b of bestaand) if (b.moneybird_estimate_id) byMbId.set(String(b.moneybird_estimate_id), b);

  let nieuw = 0, bijgewerkt = 0, gewonnen = 0;
  for (const e of estimates) {
    const status = mapStatus(e.state);
    if (status === 'gewonnen') gewonnen++;
    const contact = e.contact || {};
    const naam = contact.company_name || `${contact.firstname || ''} ${contact.lastname || ''}`.trim() || 'Onbekend';
    const velden = {
      bedrijf: bedrijfId,
      bron: 'moneybird',
      status,
      offertenummer: e.estimate_id || '',
      contact_naam: naam,
      contact_plaats: contact.city || '',
      waarde: Number(e.total_price_incl_tax || e.total_price_excl_tax || 0),
      offerte_datum: e.estimate_date || null,
      referentie: e.reference || '',
      moneybird_estimate_id: String(e.id),
      moneybird_state: e.state,
      moneybird_url: e.url || '',
    };
    const bestaande = byMbId.get(String(e.id));
    if (bestaande) {
      // alleen sync-velden bijwerken, handmatige event-data laten staan
      await directus.request(updateItem('Boekingen', bestaande.id, {
        status: velden.status, offertenummer: velden.offertenummer, waarde: velden.waarde,
        moneybird_state: velden.moneybird_state, referentie: bestaande.referentie || velden.referentie,
      } as any));
      bijgewerkt++;
    } else {
      await directus.request(createItem('Boekingen', velden as any));
      nieuw++;
    }
  }

  logger.info(`Offerte-sync bedrijf ${bedrijfId}: ${estimates.length} estimates, ${nieuw} nieuw, ${bijgewerkt} bijgewerkt, ${gewonnen} gewonnen`);
  return { opgehaald: estimates.length, nieuw, bijgewerkt, gewonnen };
}
