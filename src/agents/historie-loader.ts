/**
 * Historie-loader: haalt de echte event-info uit bestaande Moneybird-boekingen.
 *
 * De gewonnen boekingen hebben de datum/locatie/aantal in het vrije referentie-veld
 * (bv. "7 juli 11:00 - 150 x 1 bol op school de Mozaiek Zeewolde"). Die parsen we
 * met Claude naar event_datum, locatie, aantal en event_type, zodat ze in de
 * agenda en planning verschijnen. Geen Moneybird-token nodig: de data staat al in
 * Directus.
 */

import Anthropic from '@anthropic-ai/sdk';
import { directus } from '../config/directus';
import { readItems, updateItem } from '@directus/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

interface Parsed { id: number; event_datum: string | null; locatie: string; aantal: string; event_type: string; titel: string; }

export interface HistorieResult { bekeken: number; bijgewerkt: number; zonder_datum: number; }

/**
 * Parse de referentie van gewonnen boekingen zonder event_datum en vul de
 * event-velden. Werkt in batches via één Claude-call per groep.
 */
export async function laadMoneybirdHistorie(bedrijfId: number): Promise<HistorieResult> {
  const boekingen = (await directus.request(
    readItems('Boekingen', {
      filter: { bedrijf: { _eq: bedrijfId }, status: { _eq: 'gewonnen' } } as any,
      limit: -1,
    })
  )) as any[];

  // alleen die nog geen event_datum hebben maar wel een referentie met inhoud
  const teParsen = boekingen.filter((b) => !b.event_datum && String(b.referentie || '').trim().length > 3);
  if (!teParsen.length) return { bekeken: boekingen.length, bijgewerkt: 0, zonder_datum: boekingen.filter((b) => !b.event_datum).length };

  let bijgewerkt = 0;
  const batchSize = 25;
  for (let i = 0; i < teParsen.length; i += batchSize) {
    const batch = teParsen.slice(i, i + batchSize);
    const lijst = batch.map((b) => ({
      id: b.id,
      referentie: String(b.referentie || ''),
      klant: String(b.contact_naam || ''),
      offerte_jaar: String(b.offerte_datum || '').slice(0, 4) || '2026',
    }));

    const prompt = `Je krijgt boekingen van een ijscateraar. Haal uit het "referentie"-veld de event-gegevens.
Voor elke boeking, bepaal:
- event_datum: de datum dat ze op locatie staan, als YYYY-MM-DD. Gebruik offerte_jaar als jaar tenzij anders vermeld. Kun je geen datum vinden, gebruik null.
- locatie: plaats of adres, of leeg.
- aantal: aantal gasten/bollen indien genoemd, anders leeg.
- event_type: ijskraam, ijsbus, ijsscooter of gelatobar als af te leiden, anders leeg.
- titel: korte herkenbare naam (klant + plaats of gelegenheid).

Boekingen:
${JSON.stringify(lijst)}

Antwoord UITSLUITEND met een JSON-array: [{"id","event_datum","locatie","aantal","event_type","titel"}].`;

    const resp = await anthropic.messages.create({ model: env.ANTHROPIC_MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] });
    const txt = resp.content.filter((c) => c.type === 'text').map((c) => (c as any).text).join('');
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) { logger.warn('Historie-loader: geen JSON in batch'); continue; }
    let parsed: Parsed[] = [];
    try { parsed = JSON.parse(m[0]); } catch { logger.warn('Historie-loader: JSON parse faalde'); continue; }

    for (const p of parsed) {
      if (!p || !p.id) continue;
      const patch: Record<string, unknown> = {};
      if (p.event_datum && /^\d{4}-\d{2}-\d{2}$/.test(p.event_datum)) patch.event_datum = p.event_datum;
      if (p.locatie) patch.locatie = p.locatie;
      if (p.event_type) patch.event_type = p.event_type;
      if (p.titel) patch.titel = String(p.titel).replace(/\s*[–—]\s*/g, ' ').trim();
      if (p.aantal) patch.notitie = `${p.aantal} gasten/bollen`;
      if (Object.keys(patch).length) {
        try { await directus.request(updateItem('Boekingen', p.id, patch as any)); if (patch.event_datum) bijgewerkt++; } catch (e) { logger.warn(`Historie-loader update ${p.id} faalde`); }
      }
    }
  }

  const naLoop = (await directus.request(readItems('Boekingen', { filter: { bedrijf: { _eq: bedrijfId }, status: { _eq: 'gewonnen' } } as any, fields: ['event_datum'], limit: -1 }))) as any[];
  logger.info(`Historie-loader bedrijf ${bedrijfId}: ${bijgewerkt} boekingen kregen een event_datum`);
  return { bekeken: boekingen.length, bijgewerkt, zonder_datum: naLoop.filter((b) => !b.event_datum).length };
}
