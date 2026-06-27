import { directus } from '../config/directus';
import { readItems } from '@directus/sdk';
import { logger } from '../utils/logger';

interface Bucket { aantal: number; waarde: number; }
function bucket(): Bucket { return { aantal: 0, waarde: 0 }; }
function round(n: number): number { return Math.round((Number(n) || 0) * 100) / 100; }

export interface JaarOmzet { jaar: number; omzet: number; compleet: boolean; bron: string }

/**
 * Meerjaren-omzettrend: historische jaren (2020-2024) uit de Excel-boekhouding
 * (collectie Omzet_Historie) gecombineerd met de live berekende 2025/2026.
 */
export async function getMeerjarenOmzet(bedrijfId: number): Promise<JaarOmzet[]> {
  const historie = (await directus.request(
    readItems('Omzet_Historie', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 })
  )) as any[];

  const jaren: JaarOmzet[] = historie.map((h) => ({
    jaar: Number(h.jaar),
    omzet: round(h.omzet),
    compleet: !!h.compleet,
    bron: 'boekhouding (excel)',
  }));

  for (const y of [2025, 2026]) {
    const o = await getFinanceOverview(bedrijfId, y);
    jaren.push({ jaar: y, omzet: o.totaal_omzet, compleet: y < 2026, bron: 'moneybird + pos' });
  }

  return jaren.sort((a, b) => a.jaar - b.jaar);
}

export interface FinanceOverview {
  bedrijfId: number;
  jaar: number | null;
  gefactureerd: Bucket;   // echte gefactureerde events-omzet (Moneybird sales invoices)
  moneybird: {
    gewonnen: Bucket;   // accepted + billed (offertes)
    open: Bucket;       // nog levende offertes (pipeline)
    verlopen: Bucket;   // late
    afgewezen: Bucket;  // rejected
    totaal_offertes: number;
  };
  pos: {
    omzet: number;
    transacties: number;
    per_maand: Array<{ maand: string; transacties: number; omzet: number }>;
    top_ijscomannen: Array<{ naam: string; omzet: number; transacties: number }>;
  };
  totaal_omzet: number;   // gewonnen boekingen + POS
  lekkage: number;        // verlopen + afgewezen offertes (terug te winnen)
}

/**
 * Combineert de geboekte events (Moneybird via Boekingen) met de losse
 * schepverkopen (Zettle via POS_Verkopen) tot één omzetbeeld + de offerte-lekkage.
 */
export async function getFinanceOverview(bedrijfId: number, jaar?: number): Promise<FinanceOverview> {
  let [boekingen, pos, facturen] = await Promise.all([
    directus.request(readItems('Boekingen', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 })) as Promise<any[]>,
    directus.request(readItems('POS_Verkopen', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 })) as Promise<any[]>,
    directus.request(readItems('Facturen', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 })) as Promise<any[]>,
  ]);

  // Filter op jaar (offerte_datum / verkocht_op / factuurdatum)
  if (jaar) {
    const y = String(jaar);
    boekingen = boekingen.filter((b) => String(b.offerte_datum || '').startsWith(y));
    pos = pos.filter((p) => String(p.verkocht_op || '').startsWith(y));
    facturen = facturen.filter((fc) => String(fc.factuurdatum || '').startsWith(y));
  }

  const gefactureerd = bucket();
  for (const fc of facturen) { gefactureerd.aantal++; gefactureerd.waarde += Number(fc.bedrag) || 0; }

  const gewonnen = bucket(), open = bucket(), verlopen = bucket(), afgewezen = bucket();
  for (const b of boekingen) {
    const w = Number(b.waarde) || 0;
    switch (b.status) {
      case 'gewonnen': gewonnen.aantal++; gewonnen.waarde += w; break;
      case 'open': open.aantal++; open.waarde += w; break;
      case 'verlopen': verlopen.aantal++; verlopen.waarde += w; break;
      case 'afgewezen': afgewezen.aantal++; afgewezen.waarde += w; break;
      default: break; // concept/gearchiveerd buiten beschouwing
    }
  }

  const maanden = new Map<string, { transacties: number; omzet: number }>();
  const mannen = new Map<string, { omzet: number; transacties: number }>();
  let posOmzet = 0;
  for (const p of pos) {
    const bedrag = Number(p.bedrag) || 0;
    posOmzet += bedrag;
    const maand = String(p.verkocht_op || '').slice(0, 7);
    if (maand) {
      const m = maanden.get(maand) || { transacties: 0, omzet: 0 };
      m.transacties++; m.omzet += bedrag; maanden.set(maand, m);
    }
    const naam = String(p.ijscoman || 'Onbekend');
    const man = mannen.get(naam) || { omzet: 0, transacties: 0 };
    man.omzet += bedrag; man.transacties++; mannen.set(naam, man);
  }

  const round = (n: number) => Math.round(n * 100) / 100;
  const per_maand = [...maanden.entries()].sort().map(([maand, v]) => ({ maand, transacties: v.transacties, omzet: round(v.omzet) }));
  const top_ijscomannen = [...mannen.entries()]
    .map(([naam, v]) => ({ naam, omzet: round(v.omzet), transacties: v.transacties }))
    .sort((a, b) => b.omzet - a.omzet).slice(0, 8);

  logger.info(`Finance overview bedrijf ${bedrijfId}: ${boekingen.length} boekingen, ${pos.length} POS-transacties`);

  return {
    bedrijfId,
    jaar: jaar || null,
    gefactureerd: { aantal: gefactureerd.aantal, waarde: round(gefactureerd.waarde) },
    moneybird: {
      gewonnen: { aantal: gewonnen.aantal, waarde: round(gewonnen.waarde) },
      open: { aantal: open.aantal, waarde: round(open.waarde) },
      verlopen: { aantal: verlopen.aantal, waarde: round(verlopen.waarde) },
      afgewezen: { aantal: afgewezen.aantal, waarde: round(afgewezen.waarde) },
      totaal_offertes: boekingen.length,
    },
    pos: { omzet: round(posOmzet), transacties: pos.length, per_maand, top_ijscomannen },
    totaal_omzet: round(gefactureerd.waarde + posOmzet),
    lekkage: round(verlopen.waarde + afgewezen.waarde),
  };
}
