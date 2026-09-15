/**
 * Omzetmix: splitst een jaar uit naar verdienmodel en naar middel.
 *
 * IJs uit de Polder draait vier modellen door elkaar (zakelijk, evenement,
 * venten, particulier) op vijf soorten materieel. In één totaalbedrag valt niet
 * te zien waar het geld vandaan komt, en dus ook niet waar het weglekt: in 2026
 * stortte venten in van 13 naar 3 dagen terwijl evenementen juist beter werden,
 * en dat viel tegen elkaar weg in het totaal.
 */

import { directus } from '../config/directus';
import { readItems } from '@directus/sdk';
import { logger } from '../utils/logger';

export interface MixRegel {
  soort: string;
  kassa_omzet: number;
  kassa_dagen: number;
  omzet_per_dag: number;
  factuur_omzet: number;
  boekingen: number;
  totaal: number;
}

export interface MiddelRegel {
  middel: string;
  boekingen: number;
  omzet: number;
  per_boeking: number;
}

export interface OmzetMix {
  bedrijfId: number;
  jaar: number;
  per_soort: MixRegel[];
  per_middel: MiddelRegel[];
  ongelabeld: { kassa_dagen: number; kassa_omzet: number; boekingen: number };
}

const rond = (n: number) => Math.round(n * 100) / 100;

export async function getOmzetMix(bedrijfId: number, jaar: number): Promise<OmzetMix> {
  const y = String(jaar);
  const [pos, boekingen] = await Promise.all([
    directus.request(readItems('POS_Verkopen', {
      filter: { bedrijf: { _eq: bedrijfId } }, limit: -1,
      fields: ['verkocht_op', 'bedrag', 'soort'],
    })) as Promise<Array<{ verkocht_op?: string; bedrag?: number; soort?: string }>>,
    directus.request(readItems('Boekingen', {
      filter: { bedrijf: { _eq: bedrijfId } }, limit: -1,
      fields: ['offerte_datum', 'event_datum', 'waarde', 'status', 'soort', 'middel'],
    })) as Promise<Array<{ offerte_datum?: string; event_datum?: string; waarde?: number; status?: string; soort?: string; middel?: string }>>,
  ]);

  // Kassa: per soort optellen, en dagen tellen zodat opbrengst per dag te zien is.
  const kassa = new Map<string, { omzet: number; dagen: Set<string> }>();
  for (const r of pos) {
    const datum = String(r.verkocht_op || '');
    if (!datum.startsWith(y)) continue;
    const soort = r.soort || 'ongelabeld';
    const b = kassa.get(soort) || { omzet: 0, dagen: new Set<string>() };
    b.omzet += Number(r.bedrag) || 0;
    b.dagen.add(datum.slice(0, 10));
    kassa.set(soort, b);
  }

  // Boekingen: alleen gewonnen telt als omzet. Een evenement staat vaak op nul
  // omdat het publiek zelf afrekent; die omzet zit dan in de kassa.
  const fact = new Map<string, { omzet: number; aantal: number }>();
  const middel = new Map<string, { omzet: number; aantal: number }>();
  for (const b of boekingen) {
    const datum = String(b.event_datum || b.offerte_datum || '');
    if (!datum.startsWith(y) || b.status !== 'gewonnen') continue;
    const waarde = Number(b.waarde) || 0;

    const s = fact.get(b.soort || 'ongelabeld') || { omzet: 0, aantal: 0 };
    s.omzet += waarde; s.aantal++;
    fact.set(b.soort || 'ongelabeld', s);

    if (b.middel && b.middel !== 'onbekend' && waarde > 0) {
      const m = middel.get(b.middel) || { omzet: 0, aantal: 0 };
      m.omzet += waarde; m.aantal++;
      middel.set(b.middel, m);
    }
  }

  const soorten = new Set([...kassa.keys(), ...fact.keys()].filter((s) => s !== 'ongelabeld'));
  const per_soort: MixRegel[] = [...soorten].map((soort) => {
    const k = kassa.get(soort) || { omzet: 0, dagen: new Set<string>() };
    const f = fact.get(soort) || { omzet: 0, aantal: 0 };
    return {
      soort,
      kassa_omzet: rond(k.omzet),
      kassa_dagen: k.dagen.size,
      omzet_per_dag: k.dagen.size ? rond(k.omzet / k.dagen.size) : 0,
      factuur_omzet: rond(f.omzet),
      boekingen: f.aantal,
      totaal: rond(k.omzet + f.omzet),
    };
  }).sort((a, b) => b.totaal - a.totaal);

  const per_middel: MiddelRegel[] = [...middel.entries()]
    .map(([m, v]) => ({ middel: m, boekingen: v.aantal, omzet: rond(v.omzet), per_boeking: rond(v.omzet / v.aantal) }))
    .sort((a, b) => b.per_boeking - a.per_boeking);

  const ok = kassa.get('ongelabeld') || { omzet: 0, dagen: new Set<string>() };
  const of = fact.get('ongelabeld') || { omzet: 0, aantal: 0 };

  logger.info(`Omzetmix bedrijf ${bedrijfId} ${jaar}: ${per_soort.length} soorten, ${per_middel.length} middelen`);
  return {
    bedrijfId, jaar, per_soort, per_middel,
    ongelabeld: { kassa_dagen: ok.dagen.size, kassa_omzet: rond(ok.omzet), boekingen: of.aantal },
  };
}
