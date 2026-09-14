/**
 * Deelt kassadagen in naar verdienmodel op basis van de GPS-punten die Zettle
 * bij elke verkoop meestuurt. Venten is rijden, een evenement is stilstaan, en
 * dat verschil zie je terug in hoe ver de verkopen van die dag uit elkaar
 * liggen. Zonder dit onderscheid staat alles op één hoop in het dashboard,
 * terwijl het drie verschillende bedrijven zijn met verschillende marges.
 *
 * Een handmatig gezette soort wordt nooit overschreven: het GPS-signaal is een
 * vermoeden, Luke en Levi weten wat er echt stond.
 */

import { directus } from '../config/directus';
import { readItems, updateItem } from '@directus/sdk';
import { logger } from '../utils/logger';

// Binnen deze straal blijft de kar op één plek staan.
const EVENEMENT_KM = 0.3;
// Hierboven is het onmiskenbaar een route door een wijk of tussen dorpen.
const VENTEN_KM = 1.0;
// Aandeel van de verkopen dat de spreiding bepaalt. De uiterste hoeken van een
// dag zeggen niets: op Havendagen Zeewolde stond de kar zeven uur op hetzelfde
// punt, maar een paar losse prikken (bijladen) maakten er 3,3 km van en dus
// ten onrechte een ventdag. Daarom kijken we naar waar het gros zit.
const PERCENTIEL = 0.9;

function afstandKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function mediaan(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export type PosSoort = 'venten' | 'evenement' | 'onbekend';

/**
 * Spreiding = de afstand waarbinnen 90% van de verkopen valt, gemeten vanaf het
 * mediane punt van die dag. Bestand tegen uitschieters, in tegenstelling tot de
 * omhullende rechthoek.
 */
export function soortVoorDag(punten: Array<[number, number]>): { soort: PosSoort; spreiding_km: number } {
  if (punten.length < 5) return { soort: 'onbekend', spreiding_km: 0 };
  const hart: [number, number] = [mediaan(punten.map((p) => p[0])), mediaan(punten.map((p) => p[1]))];
  const afstanden = punten.map((p) => afstandKm(hart, p)).sort((a, b) => a - b);
  const spreiding = afstanden[Math.min(afstanden.length - 1, Math.floor(afstanden.length * PERCENTIEL))];
  if (spreiding < EVENEMENT_KM) return { soort: 'evenement', spreiding_km: spreiding };
  if (spreiding > VENTEN_KM) return { soort: 'venten', spreiding_km: spreiding };
  return { soort: 'onbekend', spreiding_km: spreiding };
}

export interface ClassificatieResult {
  dagen: number;
  bijgewerkt: number;
  overgeslagen: number;
  per_soort: Record<string, { dagen: number; omzet: number }>;
}

export async function classificeerPosDagen(bedrijfId: number): Promise<ClassificatieResult> {
  const rijen = (await directus.request(
    readItems('POS_Verkopen', {
      filter: { bedrijf: { _eq: bedrijfId } },
      limit: -1,
      fields: ['id', 'verkocht_op', 'bedrag', 'lat', 'lng', 'soort'],
    }),
  )) as Array<{ id: number; verkocht_op?: string; bedrag?: number; lat?: number; lng?: number; soort?: string }>;

  const perDag = new Map<string, typeof rijen>();
  for (const r of rijen) {
    const dag = String(r.verkocht_op || '').slice(0, 10);
    if (!dag) continue;
    const lijst = perDag.get(dag) || [];
    lijst.push(r);
    perDag.set(dag, lijst);
  }

  let bijgewerkt = 0;
  let overgeslagen = 0;
  const perSoort: Record<string, { dagen: number; omzet: number }> = {};

  for (const [, dagRijen] of perDag) {
    const punten = dagRijen
      .filter((r) => r.lat != null && r.lng != null)
      .map((r) => [Number(r.lat), Number(r.lng)] as [number, number]);
    const { soort } = soortVoorDag(punten);

    const omzet = dagRijen.reduce((s, r) => s + (Number(r.bedrag) || 0), 0);
    const bucket = perSoort[soort] || { dagen: 0, omzet: 0 };
    bucket.dagen++;
    bucket.omzet = Math.round((bucket.omzet + omzet) * 100) / 100;
    perSoort[soort] = bucket;

    for (const r of dagRijen) {
      // handmatige correcties met rust laten
      if (r.soort) { overgeslagen++; continue; }
      await directus.request(updateItem('POS_Verkopen', r.id, { soort } as never));
      bijgewerkt++;
    }
  }

  logger.info(`POS-classificatie bedrijf ${bedrijfId}: ${perDag.size} dagen, ${bijgewerkt} rijen gezet, ${overgeslagen} met de hand ingevuld`);
  return { dagen: perDag.size, bijgewerkt, overgeslagen, per_soort: perSoort };
}
