/**
 * Factuur-sync: haalt de verkoopfacturen uit Moneybird op en houdt Facturen
 * actueel. Net als bij de kassaverkopen was dit handwerk: de laatste import
 * dateerde van 27 juni 2026, waardoor "Gefactureerd (events)" op het dashboard
 * maandenlang een bevroren getal was dat wel als omzet werd meegeteld.
 *
 * Dedup op moneybird_invoice_id, dus herhaald draaien is veilig. Bedragen en
 * status worden bijgewerkt, zodat een creditering of late betaling doorkomt.
 */

import axios from 'axios';
import { directus } from '../config/directus';
import { readItems, createItem, updateItem } from '@directus/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const ADMIN = () => env.IJS_MONEYBIRD_ADMINISTRATION_ID || '299278260688127925';

export interface FactuurSyncResult { opgehaald: number; nieuw: number; bijgewerkt: number; }

export async function syncFacturen(bedrijfId: number): Promise<FactuurSyncResult> {
  const token = env.IJS_MONEYBIRD_API_TOKEN;
  if (!token) throw new Error('IJS_MONEYBIRD_API_TOKEN ontbreekt');
  const base = `https://moneybird.com/api/v2/${ADMIN()}`;
  const headers = { Authorization: `Bearer ${token}` };

  // Vorig en huidig jaar ophalen; ouder dan dat verandert niet meer en staat
  // al in Omzet_Historie.
  const facturen: any[] = [];
  const huidigJaar = new Date().getFullYear();
  for (let jaar = huidigJaar - 1; jaar <= huidigJaar; jaar++) {
    for (let page = 1; page <= 20; page++) {
      const url = `${base}/sales_invoices.json?filter=period:${jaar}01..${jaar}12&per_page=100&page=${page}`;
      const { data } = await axios.get(url, { headers, timeout: 30000 });
      if (!Array.isArray(data) || data.length === 0) break;
      facturen.push(...data);
      if (data.length < 100) break;
    }
  }

  const bestaand = (await directus.request(
    readItems('Facturen', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 }),
  )) as any[];
  const byMbId = new Map<string, any>();
  for (const f of bestaand) if (f.moneybird_invoice_id) byMbId.set(String(f.moneybird_invoice_id), f);

  let nieuw = 0;
  let bijgewerkt = 0;

  for (const f of facturen) {
    // Concepten zijn nog geen omzet; die horen niet in de cijfers.
    if (String(f.state || '').toLowerCase() === 'draft') continue;

    const contact = f.contact || {};
    const naam = contact.company_name
      || `${contact.firstname || ''} ${contact.lastname || ''}`.trim()
      || 'Onbekend';

    const velden = {
      bedrijf: bedrijfId,
      moneybird_invoice_id: String(f.id),
      state: f.state || '',
      bedrag: Number(f.total_price_incl_tax || f.total_price_excl_tax || 0),
      factuurdatum: f.invoice_date || null,
      contact_naam: naam,
    };

    const bestaande = byMbId.get(String(f.id));
    if (bestaande) {
      // Alleen schrijven als er echt iets veranderd is, scheelt ruis in Directus.
      if (Number(bestaande.bedrag) !== velden.bedrag || bestaande.state !== velden.state) {
        await directus.request(updateItem('Facturen', bestaande.id, {
          state: velden.state, bedrag: velden.bedrag, factuurdatum: velden.factuurdatum,
        } as never));
        bijgewerkt++;
      }
    } else {
      await directus.request(createItem('Facturen', velden as never));
      nieuw++;
    }
  }

  logger.info(`Factuur-sync bedrijf ${bedrijfId}: ${facturen.length} opgehaald, ${nieuw} nieuw, ${bijgewerkt} bijgewerkt`);
  return { opgehaald: facturen.length, nieuw, bijgewerkt };
}

/**
 * Hoe oud is de laatste factuur? Zelfde reden als bij posVersheid: een bevroren
 * getal dat als omzet wordt gepresenteerd is erger dan een zichtbaar gat.
 */
export async function factuurVersheid(bedrijfId: number): Promise<{
  laatste_factuur: string | null;
  dagen_oud: number | null;
  verouderd: boolean;
}> {
  const rijen = (await directus.request(
    readItems('Facturen', {
      filter: { bedrijf: { _eq: bedrijfId } },
      sort: ['-factuurdatum'],
      limit: 1,
      fields: ['factuurdatum'],
    }),
  )) as Array<{ factuurdatum?: string }>;

  const laatste = rijen[0]?.factuurdatum || null;
  if (!laatste) return { laatste_factuur: null, dagen_oud: null, verouderd: true };

  const dagen = Math.floor((Date.now() - new Date(laatste).getTime()) / 86400000);
  // Facturen komen minder vaak dan kassaverkopen; pas na een maand stilte gek.
  return { laatste_factuur: laatste, dagen_oud: dagen, verouderd: dagen > 31 };
}
