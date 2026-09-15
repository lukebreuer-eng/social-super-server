/**
 * Markeert kassabonnen die in werkelijkheid de afrekening van een boeking zijn.
 *
 * De omzet werd berekend als gefactureerd + kassa. Rekent een klant zijn hele
 * boeking af op de pin, dan staat datzelfde bedrag in allebei en telt het dubbel.
 * Voorbeeld: Chantal van der meulen, EUR 161,05 op de kassa op 13 juni en
 * EUR 161,05 op factuur op 22 juni. Eén klus, twee keer geteld.
 *
 * Herkenning: een losse bon vanaf EUR 50 waarvoor op diezelfde dag een gewonnen
 * boeking staat met nagenoeg hetzelfde bedrag. Een gewoon ijsje zit rond de
 * EUR 4,50, dus zulke bonnen zijn zeldzaam: negen stuks over twee jaar.
 */

import { directus } from '../config/directus';
import { readItems, updateItem } from '@directus/sdk';
import { logger } from '../utils/logger';

// Onder dit bedrag is een bon gewoon een klant met een paar bolletjes.
const BON_DREMPEL = 50;
// Speelruimte tussen bon en boeking: btw-afronding en een extra bolletje.
const MARGE = 0.04;

export interface DubbelResult {
  onderzocht: number;
  gemarkeerd: number;
  bedrag: number;
  gevallen: Array<{ datum: string; bedrag: number; boeking: string; boeking_waarde: number }>;
}

export async function markeerFactuurBetalingen(bedrijfId: number): Promise<DubbelResult> {
  const [bonnen, boekingen] = await Promise.all([
    directus.request(readItems('POS_Verkopen', {
      filter: { bedrijf: { _eq: bedrijfId } }, limit: -1,
      fields: ['id', 'verkocht_op', 'bedrag', 'factuur_betaling'],
    })) as Promise<Array<{ id: number; verkocht_op?: string; bedrag?: number; factuur_betaling?: boolean }>>,
    directus.request(readItems('Boekingen', {
      filter: { bedrijf: { _eq: bedrijfId }, status: { _eq: 'gewonnen' } }, limit: -1,
      fields: ['contact_naam', 'waarde', 'event_datum', 'offerte_datum'],
    })) as Promise<Array<{ contact_naam?: string; waarde?: number; event_datum?: string; offerte_datum?: string }>>,
  ]);

  // Boekingen op de dag waarop ze plaatsvonden; zonder eventdatum valt er niets
  // te matchen, want de offertedatum ligt meestal weken eerder.
  const perDag = new Map<string, Array<{ naam: string; waarde: number }>>();
  for (const b of boekingen) {
    const datum = String(b.event_datum || '').slice(0, 10);
    const waarde = Number(b.waarde) || 0;
    if (!datum || waarde <= 0) continue;
    const lijst = perDag.get(datum) || [];
    lijst.push({ naam: b.contact_naam || 'onbekend', waarde });
    perDag.set(datum, lijst);
  }

  const gevallen: DubbelResult['gevallen'] = [];
  let gemarkeerd = 0;
  let bedrag = 0;
  let onderzocht = 0;

  for (const bon of bonnen) {
    const b = Number(bon.bedrag) || 0;
    if (b < BON_DREMPEL) continue;
    onderzocht++;
    const datum = String(bon.verkocht_op || '').slice(0, 10);
    const kandidaten = perDag.get(datum) || [];
    const match = kandidaten.find((k) => Math.abs(k.waarde - b) <= Math.max(2, k.waarde * MARGE));
    if (!match) continue;

    if (!bon.factuur_betaling) {
      await directus.request(updateItem('POS_Verkopen', bon.id, { factuur_betaling: true } as never));
      gemarkeerd++;
    }
    bedrag += b;
    gevallen.push({ datum, bedrag: b, boeking: match.naam, boeking_waarde: match.waarde });
  }

  logger.info(`Dubbele omzet bedrijf ${bedrijfId}: ${onderzocht} grote bonnen bekeken, ${gevallen.length} zijn een factuurbetaling (EUR ${bedrag.toFixed(2)})`);
  return { onderzocht, gemarkeerd, bedrag: Math.round(bedrag * 100) / 100, gevallen };
}
