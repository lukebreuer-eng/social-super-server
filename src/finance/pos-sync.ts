/**
 * POS-sync: haalt de schepverkopen uit Zettle en zet ze in POS_Verkopen.
 *
 * Tot nu toe was dit een handmatige import. Die is op 21 juni 2026 voor het
 * laatst gedraaid, waardoor juli en augustus - de twee drukste ijsmaanden -
 * volledig buiten de omzetcijfers vielen en het dashboard 2026 op -49% zette.
 *
 * Dedup gaat op purchaseUUID, dus herhaald draaien is veilig. De sync is
 * incrementeel: hij begint bij de laatst bekende verkoop min een dag overlap,
 * zodat late synchronisaties vanaf de kassa alsnog binnenkomen.
 */

import axios from 'axios';
import { directus } from '../config/directus';
import { readItems, createItem } from '@directus/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const OAUTH_URL = 'https://oauth.zettle.com/token';
const PURCHASE_URL = 'https://purchase.izettle.com/purchases/v2';
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

// Hoeveel dagen we terug overlappen bij een incrementele run.
const OVERLAP_DAGEN = 2;
// Waar we beginnen als er nog helemaal niets in POS_Verkopen staat.
const EERSTE_START = '2025-01-01';

let cache: { token: string; verlooptOp: number } | null = null;

async function accessToken(): Promise<string> {
  if (cache && cache.verlooptOp > Date.now() + 60_000) return cache.token;

  const clientId = env.ZETTLE_CLIENT_ID;
  const apiKey = env.ZETTLE_API_KEY;
  if (!clientId || !apiKey) throw new Error('ZETTLE_CLIENT_ID of ZETTLE_API_KEY ontbreekt');

  const body = new URLSearchParams({ grant_type: JWT_BEARER, client_id: clientId, assertion: apiKey });
  const res = await axios.post(OAUTH_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });

  const token = res.data?.access_token;
  if (!token) throw new Error('Zettle gaf geen access_token terug');
  const geldig = Number(res.data?.expires_in) || 7200;
  cache = { token, verlooptOp: Date.now() + geldig * 1000 };
  return token;
}

interface ZettlePurchase {
  purchaseUUID?: string;
  purchaseNumber?: number;
  amount?: number;              // in centen
  timestamp?: string;
  userDisplayName?: string;
  refund?: boolean;
  gpsCoordinates?: { latitude?: number; longitude?: number };
  products?: Array<{ quantity?: string | number }>;
  payments?: Array<{ type?: string }>;
}

async function haalPurchases(vanaf: string): Promise<ZettlePurchase[]> {
  const token = await accessToken();
  const alles: ZettlePurchase[] = [];
  let hash: string | undefined;

  // De v2-API pagineert met lastPurchaseHash. De bovengrens is een vangnet
  // tegen een oneindige lus als Zettle ooit dezelfde hash blijft teruggeven.
  for (let pagina = 0; pagina < 200; pagina++) {
    const params: Record<string, string | number> = { startDate: vanaf, limit: 1000 };
    if (hash) params.lastPurchaseHash = hash;

    const res = await axios.get(PURCHASE_URL, {
      params,
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000,
    });

    const batch: ZettlePurchase[] = res.data?.purchases || [];
    alles.push(...batch);

    const volgende = res.data?.lastPurchaseHash;
    if (!batch.length || !volgende || volgende === hash) break;
    hash = volgende;
  }

  return alles;
}

function aantalProducten(p: ZettlePurchase): number {
  if (!Array.isArray(p.products)) return 0;
  return p.products.reduce((n, prod) => n + (Number(prod?.quantity) || 1), 0);
}

export interface PosSyncResult {
  opgehaald: number;
  nieuw: number;
  overgeslagen: number;
  vanaf: string;
  nieuwste: string | null;
}

export async function syncPosVerkopen(bedrijfId: number): Promise<PosSyncResult> {
  // Startdatum bepalen uit wat we al hebben.
  const laatste = (await directus.request(
    readItems('POS_Verkopen', {
      filter: { bedrijf: { _eq: bedrijfId } },
      sort: ['-verkocht_op'],
      limit: 1,
      fields: ['verkocht_op'],
    }),
  )) as Array<{ verkocht_op?: string }>;

  let vanaf = EERSTE_START;
  if (laatste[0]?.verkocht_op) {
    const d = new Date(laatste[0].verkocht_op);
    d.setDate(d.getDate() - OVERLAP_DAGEN);
    vanaf = d.toISOString().slice(0, 10);
  }

  const purchases = await haalPurchases(vanaf);

  // Alles wat we in dit venster al hebben, om dubbelen te voorkomen.
  const bestaand = (await directus.request(
    readItems('POS_Verkopen', {
      filter: { bedrijf: { _eq: bedrijfId }, verkocht_op: { _gte: `${vanaf}T00:00:00Z` } } as never,
      limit: -1,
      fields: ['zettle_uuid'],
    }),
  )) as Array<{ zettle_uuid?: string }>;
  const bekend = new Set(bestaand.map((r) => r.zettle_uuid).filter(Boolean) as string[]);

  let nieuw = 0;
  let overgeslagen = 0;
  let nieuwste: string | null = null;

  for (const p of purchases) {
    const uuid = p.purchaseUUID;
    if (!uuid || bekend.has(uuid)) { overgeslagen++; continue; }

    const centen = Number(p.amount) || 0;
    // Een retour komt binnen als losse purchase met refund=true en een positief
    // bedrag. Negatief wegschrijven, anders telt een terugbetaling als omzet.
    const bedrag = (p.refund ? -centen : centen) / 100;

    await directus.request(
      createItem('POS_Verkopen', {
        bedrijf: bedrijfId,
        zettle_uuid: uuid,
        purchase_nr: p.purchaseNumber ?? null,
        bedrag,
        verkocht_op: p.timestamp ? new Date(p.timestamp).toISOString() : null,
        ijscoman: p.userDisplayName || 'Onbekend',
        lat: p.gpsCoordinates?.latitude ?? null,
        lng: p.gpsCoordinates?.longitude ?? null,
        aantal_producten: aantalProducten(p),
        betaalwijze: p.payments?.[0]?.type || null,
      }),
    );

    bekend.add(uuid);
    nieuw++;
    if (p.timestamp && (!nieuwste || p.timestamp > nieuwste)) nieuwste = p.timestamp;
  }

  logger.info(
    `POS-sync bedrijf ${bedrijfId}: ${purchases.length} opgehaald vanaf ${vanaf}, ${nieuw} nieuw, ${overgeslagen} al bekend`,
  );

  return { opgehaald: purchases.length, nieuw, overgeslagen, vanaf, nieuwste };
}

/**
 * Hoe oud is de POS-data? Het dashboard toonde maandenlang een keiharde
 * omzetdaling die in werkelijkheid gewoon ontbrekende data was, dus dit hoort
 * zichtbaar te zijn naast de cijfers.
 */
export async function posVersheid(bedrijfId: number): Promise<{
  laatste_verkoop: string | null;
  dagen_oud: number | null;
  verouderd: boolean;
}> {
  const rijen = (await directus.request(
    readItems('POS_Verkopen', {
      filter: { bedrijf: { _eq: bedrijfId } },
      sort: ['-verkocht_op'],
      limit: 1,
      fields: ['verkocht_op'],
    }),
  )) as Array<{ verkocht_op?: string }>;

  const laatste = rijen[0]?.verkocht_op || null;
  if (!laatste) return { laatste_verkoop: null, dagen_oud: null, verouderd: true };

  const dagen = Math.floor((Date.now() - new Date(laatste).getTime()) / 86400000);
  return { laatste_verkoop: laatste, dagen_oud: dagen, verouderd: dagen > 3 };
}
