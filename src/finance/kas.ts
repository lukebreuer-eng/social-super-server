/**
 * Kasoverzicht: hoeveel contant er binnenkwam en wat er in de kas hoort te zitten.
 *
 * Contante ontvangsten komen uit Zettle (POS_Verkopen, betaalwijze *CASH*).
 * Alles wat er daarna mee gebeurt — afstorten, contant betalen, verschil na
 * tellen — staat in Kas_Mutaties. De beginstand van eind 2024 (EUR 3.573,30)
 * komt uit de boekhouding in Excel; daarvoor bestaan hier geen gegevens.
 */

import { directus } from '../config/directus';
import { readItems } from '@directus/sdk';
import { logger } from '../utils/logger';

export interface KasJaar {
  jaar: number;
  contant: number;
  pin: number;
  contant_bonnen: number;
  aandeel_contant: number;
  mutaties: number;
  stand_eind: number;
}

export interface KasOverzicht {
  bedrijfId: number;
  beginstand: number;
  beginstand_per: string | null;
  jaren: KasJaar[];
  huidige_stand: number;
}

const rond = (n: number) => Math.round(n * 100) / 100;

export async function getKasOverzicht(bedrijfId: number): Promise<KasOverzicht> {
  const [pos, mutaties] = await Promise.all([
    directus.request(readItems('POS_Verkopen', {
      filter: { bedrijf: { _eq: bedrijfId } }, limit: -1,
      fields: ['verkocht_op', 'bedrag', 'betaalwijze'],
    })) as Promise<Array<{ verkocht_op?: string; bedrag?: number; betaalwijze?: string }>>,
    directus.request(readItems('Kas_Mutaties', {
      filter: { bedrijf: { _eq: bedrijfId } }, limit: -1,
      fields: ['datum', 'soort', 'bedrag'],
    })) as Promise<Array<{ datum?: string; soort?: string; bedrag?: number }>>,
  ]);

  const begin = mutaties.find((m) => m.soort === 'beginstand');
  const beginstand = Number(begin?.bedrag) || 0;
  const beginJaar = begin?.datum ? Number(String(begin.datum).slice(0, 4)) : 0;

  const perJaar = new Map<number, { contant: number; pin: number; bonnen: number }>();
  for (const r of pos) {
    const jaar = Number(String(r.verkocht_op || '').slice(0, 4));
    if (!jaar) continue;
    const bedrag = Number(r.bedrag) || 0;
    const b = perJaar.get(jaar) || { contant: 0, pin: 0, bonnen: 0 };
    if (String(r.betaalwijze || '').includes('CASH')) { b.contant += bedrag; b.bonnen++; }
    else b.pin += bedrag;
    perJaar.set(jaar, b);
  }

  // Mutaties na de beginstand tellen mee; de beginstand zelf is het vertrekpunt.
  const mutPerJaar = new Map<number, number>();
  for (const m of mutaties) {
    if (m.soort === 'beginstand') continue;
    const jaar = Number(String(m.datum || '').slice(0, 4));
    if (!jaar) continue;
    mutPerJaar.set(jaar, (mutPerJaar.get(jaar) || 0) + (Number(m.bedrag) || 0));
  }

  const jaren: KasJaar[] = [];
  let stand = beginstand;
  for (const jaar of [...new Set([...perJaar.keys(), ...mutPerJaar.keys()])].sort()) {
    if (jaar <= beginJaar) continue; // zit al in de beginstand verwerkt
    const b = perJaar.get(jaar) || { contant: 0, pin: 0, bonnen: 0 };
    const mut = mutPerJaar.get(jaar) || 0;
    stand += b.contant + mut;
    const totaal = b.contant + b.pin;
    jaren.push({
      jaar,
      contant: rond(b.contant),
      pin: rond(b.pin),
      contant_bonnen: b.bonnen,
      aandeel_contant: totaal ? Math.round((b.contant / totaal) * 1000) / 10 : 0,
      mutaties: rond(mut),
      stand_eind: rond(stand),
    });
  }

  logger.info(`Kasoverzicht bedrijf ${bedrijfId}: beginstand EUR ${beginstand}, huidige stand EUR ${rond(stand)}`);
  return {
    bedrijfId,
    beginstand: rond(beginstand),
    beginstand_per: begin?.datum || null,
    jaren,
    huidige_stand: rond(stand),
  };
}
