import axios, { AxiosInstance } from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import { directus } from '../config/directus';
import { readItems, createItem, updateItem } from '@directus/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Finance Controller voor IJs uit de Polder (bedrijf 7).
 *
 * Bouwt de finance-laag uit van "omzet kijken" naar een echte controller:
 * trekt de KOSTENKANT uit Moneybird (purchase invoices + receipts, alle jaren),
 * categoriseert die slim, en levert marge-analyse, trends en groeiadvies.
 *
 * BELANGRIJK over authenticatie:
 *   IJs heeft een EIGEN Moneybird-administratie (id 299278260688127925), los van
 *   de IPVG-administratie (160907903395431834) waar de server-token MONEYBIRD_API_TOKEN
 *   bij hoort. Die server-token heeft GEEN toegang tot de IJs-administratie (404).
 *   Zet daarom een eigen IJs-token in de omgeving:
 *     IJS_MONEYBIRD_API_TOKEN=<token met toegang tot administratie 299278260688127925>
 *     IJS_MONEYBIRD_ADMINISTRATION_ID=299278260688127925   (optioneel, dit is de default)
 *   Of geef token/administrationId rechtstreeks mee via de opts-parameter.
 *
 * Alleen LEZEN uit Moneybird. Niets wordt daar aangemaakt of gewijzigd.
 */

const MONEYBIRD_API_URL = 'https://moneybird.com/api/v2';

// Bekende IJs Moneybird-administratie (afgeleid uit de moneybird_url van bestaande Boekingen).
const IJS_ADMINISTRATION_ID = '299278260688127925';

// Vanaf welk jaar we kosten ophalen (ruim voor de start, zodat geen jaar mist).
const DEFAULT_VANAF_JAAR = 2014;

const CATEGORIEEN = ['inkoop', 'huur', 'personeel', 'wagenpark', 'onderhoud', 'overig'] as const;
export type Kostencategorie = (typeof CATEGORIEEN)[number];

interface MoneybirdCreds {
  token: string;
  administrationId: string;
  bron: string;
}

export interface SyncOpts {
  token?: string;
  administrationId?: string;
  vanafJaar?: number;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Bepaalt welke Moneybird-token + administratie bij dit bedrijf hoort.
 * Voor IJs (7) eerst de IJs-specifieke env, anders de generieke server-env.
 * Gooit een duidelijke fout als er niets bruikbaars is (de bekende blocker).
 */
function resolveMoneybird(bedrijfId: number, opts?: SyncOpts): MoneybirdCreds {
  if (opts?.token) {
    return {
      token: opts.token,
      administrationId: opts.administrationId || IJS_ADMINISTRATION_ID,
      bron: 'opts',
    };
  }

  if (bedrijfId === 7) {
    const administrationId = process.env.IJS_MONEYBIRD_ADMINISTRATION_ID || IJS_ADMINISTRATION_ID;
    // Eerst de IJs-specifieke token.
    if (process.env.IJS_MONEYBIRD_API_TOKEN) {
      return { token: process.env.IJS_MONEYBIRD_API_TOKEN, administrationId, bron: 'ijs-env' };
    }
    // Alleen de generieke server-token gebruiken als die OOK bij de IJs-administratie
    // hoort. Anders zouden we IPVG-kosten als IJs-kosten wegschrijven (datavervuiling).
    if (env.MONEYBIRD_API_TOKEN && env.MONEYBIRD_ADMINISTRATION_ID === administrationId) {
      return { token: env.MONEYBIRD_API_TOKEN, administrationId, bron: 'generiek-env' };
    }
    throw new Error(
      `Geen IJs Moneybird-token. IJs heeft een EIGEN administratie (${administrationId}), los van IPVG. ` +
        `De server-token MONEYBIRD_API_TOKEN hoort bij de IPVG-administratie (${env.MONEYBIRD_ADMINISTRATION_ID || 'n/a'}) ` +
        `en heeft hier geen toegang. Zet IJS_MONEYBIRD_API_TOKEN in de omgeving of geef opts.token mee.`,
    );
  }

  // Overige bedrijven: generieke server-env (mits administratie bekend).
  if (env.MONEYBIRD_API_TOKEN && env.MONEYBIRD_ADMINISTRATION_ID) {
    return {
      token: env.MONEYBIRD_API_TOKEN,
      administrationId: env.MONEYBIRD_ADMINISTRATION_ID,
      bron: 'generiek-env',
    };
  }

  throw new Error(`Geen Moneybird-token geconfigureerd voor bedrijf ${bedrijfId}.`);
}

function makeClient(creds: MoneybirdCreds): AxiosInstance {
  return axios.create({
    baseURL: `${MONEYBIRD_API_URL}/${creds.administrationId}`,
    headers: {
      Authorization: `Bearer ${creds.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });
}

// ---------------------------------------------------------------------------
// Categorie-mapping
// ---------------------------------------------------------------------------

const CATEGORIE_REGELS: Array<{ categorie: Kostencategorie; woorden: string[] }> = [
  {
    categorie: 'personeel',
    woorden: [
      'salaris', 'salarissen', 'loon', 'lonen', 'payroll', 'personeel', 'medewerker',
      'uitzend', 'flexkracht', 'freelance', 'zzp', 'declaratie', 'pensioen', 'arbo',
      'verzuim', 'loonheffing', 'nettoloon', 'vakantiegeld', 'ijscoman', 'scholier',
    ],
  },
  {
    categorie: 'wagenpark',
    woorden: [
      'brandstof', 'tank', 'tanken', 'shell', 'esso', 'bp ', 'total', 'texaco', 'benzine',
      'diesel', 'lpg', 'auto', 'voertuig', 'wagen', 'bus', 'bedford', 'lease', 'leasing',
      'banden', 'apk', 'rdw', 'wegenbelasting', 'mrb', 'motorrijtuig', 'parkeren', 'parkeer',
      'tol', 'verzekering auto', 'autoverzekering', 'aanhanger', 'trailer', 'koelwagen',
    ],
  },
  {
    categorie: 'huur',
    woorden: [
      'huur', 'verhuur', 'pacht', 'pand', 'bedrijfsruimte', 'loods', 'opslag', 'unit',
      'vastgoed', 'standplaats', 'staanplaats', 'locatiehuur', 'kraam', 'erfpacht',
    ],
  },
  {
    categorie: 'onderhoud',
    woorden: [
      'onderhoud', 'reparatie', 'reparaties', 'herstel', 'monteur', 'installateur',
      'service', 'schoonmaak', 'reiniging', 'machine', 'machines', 'apparatuur',
      'koeling', 'vriezer', 'compressor', 'storing', 'keuring', 'ijsmachine',
    ],
  },
  {
    categorie: 'inkoop',
    woorden: [
      'inkoop', 'ijs', 'gelato', 'ingredient', 'ingredient', 'melk', 'room', 'slagroom',
      'suiker', 'vanille', 'cacao', 'chocolade', 'fruit', 'noten', 'pasta', 'smaakstof',
      'verpakking', 'beker', 'bekers', 'hoorn', 'hoorntjes', 'wafel', 'lepel', 'lepels',
      'servet', 'groothandel', 'food', 'horeca', 'levensmiddelen', 'leverancier',
      'topping', 'saus', 'sprinkles', 'spatel', 'bakkerij', 'zuivel',
    ],
  },
];

/**
 * Slimme categorie-mapping op basis van leverancier, referentie, omschrijving en
 * grootboekrekening(en). Volgorde van de regels bepaalt de prioriteit; valt terug
 * op 'overig' (bv. bank, accountant, verzekeringen, software, marketing).
 */
export function bepaalCategorie(tekst: string): Kostencategorie {
  const t = ` ${tekst.toLowerCase()} `;
  for (const regel of CATEGORIE_REGELS) {
    if (regel.woorden.some((w) => t.includes(w))) return regel.categorie;
  }
  return 'overig';
}

// ---------------------------------------------------------------------------
// Moneybird ophalen
// ---------------------------------------------------------------------------

interface MoneybirdDetail {
  description?: string;
  ledger_account_id?: string;
  total_price_excl_tax_with_discount?: string;
  price?: string;
}

interface MoneybirdDocument {
  id: string;
  reference?: string;
  date?: string;
  invoice_date?: string;
  total_price_excl_tax?: string;
  total_price_incl_tax?: string;
  contact?: { company_name?: string; firstname?: string; lastname?: string };
  contact_id?: string;
  details?: MoneybirdDetail[];
}

/** Haalt de grootboekrekeningen op (id -> naam) voor betere categorie-herkenning. */
async function fetchLedgerMap(client: AxiosInstance): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const resp = await client.get('/ledger_accounts.json', { params: { per_page: 250 } });
    for (const la of resp.data as Array<{ id: string; name: string }>) {
      map.set(String(la.id), String(la.name || ''));
    }
  } catch (e: any) {
    logger.warn(`Kon grootboekrekeningen niet ophalen: ${e.response?.status || e.message}`);
  }
  return map;
}

/**
 * Haalt ALLE documenten van een endpoint op, alle jaren, met paginatie.
 * Gebruikt period-filters per jaar zodat ook de oudste jaren meekomen
 * (de default-query mist anders oude jaren).
 */
async function fetchAllDocuments(
  client: AxiosInstance,
  endpoint: string,
  vanafJaar: number,
): Promise<MoneybirdDocument[]> {
  const huidigJaar = new Date().getFullYear();
  const perId = new Map<string, MoneybirdDocument>();

  for (let jaar = vanafJaar; jaar <= huidigJaar; jaar++) {
    const filter = `period:${jaar}01..${jaar}12`;
    let page = 1;
    // Moneybird paginates max ~100 per pagina; loop tot een lege/kortere pagina.
    for (;;) {
      let data: MoneybirdDocument[];
      try {
        const resp = await client.get(endpoint, { params: { filter, per_page: 100, page } });
        data = resp.data as MoneybirdDocument[];
      } catch (e: any) {
        const status = e.response?.status;
        if (status === 404) {
          // Endpoint bestaat niet voor deze administratie; stop met dit endpoint.
          logger.warn(`Endpoint ${endpoint} gaf 404, overgeslagen.`);
          return [...perId.values()];
        }
        logger.warn(`Fout bij ${endpoint} ${filter} p${page}: ${status || e.message}`);
        break;
      }
      if (!Array.isArray(data) || data.length === 0) break;
      for (const doc of data) perId.set(String(doc.id), doc);
      if (data.length < 100) break;
      page++;
    }
  }

  return [...perId.values()];
}

interface KostenRecord {
  bedrijf: number;
  datum: string;
  jaar: number;
  leverancier: string;
  bedrag: number;
  categorie: Kostencategorie;
  omschrijving: string;
  moneybird_id: string;
}

function docNaarKosten(
  doc: MoneybirdDocument,
  bedrijfId: number,
  ledgers: Map<string, string>,
  prefix: string,
): KostenRecord | null {
  const datum = (doc.date || doc.invoice_date || '').slice(0, 10);
  if (!datum) return null;
  const jaar = parseInt(datum.slice(0, 4), 10);

  const leverancier =
    doc.contact?.company_name ||
    [doc.contact?.firstname, doc.contact?.lastname].filter(Boolean).join(' ') ||
    'Onbekend';

  const bedrag = Math.round((Number(doc.total_price_excl_tax) || 0) * 100) / 100;

  const ledgerNamen = (doc.details || [])
    .map((d) => (d.ledger_account_id ? ledgers.get(String(d.ledger_account_id)) : '') || '')
    .filter(Boolean);
  const detailOmschrijvingen = (doc.details || []).map((d) => d.description || '').filter(Boolean);

  const matchTekst = [leverancier, doc.reference || '', ...ledgerNamen, ...detailOmschrijvingen].join(' ');
  const categorie = bepaalCategorie(matchTekst);

  const omschrijving = [doc.reference, ...detailOmschrijvingen.slice(0, 3), ...ledgerNamen.slice(0, 2)]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 500);

  return {
    bedrijf: bedrijfId,
    datum,
    jaar,
    leverancier: String(leverancier).slice(0, 255),
    bedrag,
    categorie,
    omschrijving,
    moneybird_id: `${prefix}-${doc.id}`,
  };
}

/**
 * Haalt alle kosten (purchase invoices + receipts) uit de Moneybird-administratie
 * van het bedrijf, categoriseert ze, en schrijft ze idempotent naar Directus-collectie
 * Kosten. Dedupliceert op moneybird_id. Bestaande regels worden bijgewerkt als
 * bedrag of categorie wijzigt.
 */
export async function syncKostenUitMoneybird(bedrijfId: number, opts?: SyncOpts) {
  const creds = resolveMoneybird(bedrijfId, opts);
  const vanafJaar = opts?.vanafJaar || DEFAULT_VANAF_JAAR;
  const client = makeClient(creds);

  logger.info(
    `Kosten-sync bedrijf ${bedrijfId} via administratie ${creds.administrationId} (token-bron: ${creds.bron}), vanaf ${vanafJaar}`,
  );

  const ledgers = await fetchLedgerMap(client);

  const [purchaseInvoices, receipts] = await Promise.all([
    fetchAllDocuments(client, '/documents/purchase_invoices.json', vanafJaar),
    fetchAllDocuments(client, '/documents/receipts.json', vanafJaar),
  ]);

  const records: KostenRecord[] = [];
  for (const doc of purchaseInvoices) {
    const r = docNaarKosten(doc, bedrijfId, ledgers, 'pi');
    if (r) records.push(r);
  }
  for (const doc of receipts) {
    const r = docNaarKosten(doc, bedrijfId, ledgers, 'rc');
    if (r) records.push(r);
  }

  // Bestaande Kosten ophalen voor idempotentie (dedup op moneybird_id).
  const bestaand = (await directus.request(
    readItems('Kosten', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1, fields: ['id', 'moneybird_id', 'bedrag', 'categorie'] as any }),
  )) as any[];
  const bestaandMap = new Map<string, any>(bestaand.map((b) => [String(b.moneybird_id), b]));

  let nieuw = 0;
  let bijgewerkt = 0;
  let ongewijzigd = 0;

  for (const r of records) {
    const found = bestaandMap.get(r.moneybird_id);
    if (!found) {
      await directus.request(createItem('Kosten', r as any));
      nieuw++;
    } else if (Math.abs((Number(found.bedrag) || 0) - r.bedrag) > 0.005 || found.categorie !== r.categorie) {
      await directus.request(updateItem('Kosten', found.id, { bedrag: r.bedrag, categorie: r.categorie } as any));
      bijgewerkt++;
    } else {
      ongewijzigd++;
    }
  }

  const perJaar: Record<number, number> = {};
  const perCategorie: Record<string, number> = {};
  let totaal = 0;
  for (const r of records) {
    perJaar[r.jaar] = round(((perJaar[r.jaar] || 0) + r.bedrag));
    perCategorie[r.categorie] = round(((perCategorie[r.categorie] || 0) + r.bedrag));
    totaal += r.bedrag;
  }

  const resultaat = {
    bedrijfId,
    administratie: creds.administrationId,
    token_bron: creds.bron,
    opgehaald: records.length,
    purchase_invoices: purchaseInvoices.length,
    receipts: receipts.length,
    nieuw,
    bijgewerkt,
    ongewijzigd,
    totaal_kosten: round(totaal),
    per_jaar: perJaar,
    per_categorie: perCategorie,
  };
  logger.info(`Kosten-sync klaar: ${nieuw} nieuw, ${bijgewerkt} bijgewerkt, totaal EUR ${round(totaal)}`);
  return resultaat;
}

// ---------------------------------------------------------------------------
// Controller-overzicht (omzet + kosten + marge per jaar)
// ---------------------------------------------------------------------------

function round(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export interface JaarRegel {
  jaar: number;
  omzet: number;
  omzet_bron: string;
  kosten_totaal: number;
  kosten_per_categorie: Record<Kostencategorie, number>;
  marge: number;
  marge_pct: number | null;
  geboekte_events: number; // gewonnen offertes (info, niet meegeteld in omzet om dubbeltelling te voorkomen)
  omzet_groei_pct: number | null;
  marge_groei_pct: number | null;
  trend: 'groei' | 'krimp' | 'stabiel' | null;
}

export interface ControllerOverzicht {
  bedrijfId: number;
  gegenereerd_op: string;
  jaren: JaarRegel[];
  totalen: {
    omzet: number;
    kosten: number;
    marge: number;
    marge_pct: number | null;
  };
  kosten_per_categorie_totaal: Record<Kostencategorie, number>;
  waarschuwingen: string[];
}

function legeCategorieMap(): Record<Kostencategorie, number> {
  return { inkoop: 0, huur: 0, personeel: 0, wagenpark: 0, onderhoud: 0, overig: 0 };
}

/**
 * Combineert omzet (Facturen + POS_Verkopen live, aangevuld met Omzet_Historie voor
 * oudere jaren uit de boekhouding) met de kosten uit de Kosten-collectie, per jaar
 * van het eerste databron-jaar tot nu. Levert omzet, kosten per categorie, marge en
 * een simpele jaar-op-jaar trend.
 */
export async function getControllerOverzicht(bedrijfId: number): Promise<ControllerOverzicht> {
  const [facturen, pos, boekingen, historie, kosten] = await Promise.all([
    directus.request(readItems('Facturen', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 })) as Promise<any[]>,
    directus.request(readItems('POS_Verkopen', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 })) as Promise<any[]>,
    directus.request(readItems('Boekingen', { filter: { bedrijf: { _eq: bedrijfId }, status: { _eq: 'gewonnen' } }, limit: -1 })) as Promise<any[]>,
    directus.request(readItems('Omzet_Historie', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 })) as Promise<any[]>,
    directus.request(readItems('Kosten', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 })) as Promise<any[]>,
  ]);

  const jaarVan = (d: any) => {
    const s = String(d || '');
    const y = parseInt(s.slice(0, 4), 10);
    return Number.isFinite(y) && y > 1990 ? y : null;
  };

  // Live omzet (echt geld): facturen + POS.
  const liveOmzet: Record<number, number> = {};
  for (const f of facturen) {
    const y = jaarVan(f.factuurdatum);
    if (y) liveOmzet[y] = (liveOmzet[y] || 0) + (Number(f.bedrag) || 0);
  }
  for (const p of pos) {
    const y = jaarVan(p.verkocht_op);
    if (y) liveOmzet[y] = (liveOmzet[y] || 0) + (Number(p.bedrag) || 0);
  }

  // Historische omzet uit de boekhouding (excel) — autoritair voor oude jaren.
  const historieOmzet: Record<number, number> = {};
  for (const h of historie) {
    const y = jaarVan(h.jaar) || Number(h.jaar);
    if (y) historieOmzet[y] = Number(h.omzet) || 0;
  }
  const historieMax = Object.keys(historieOmzet).length ? Math.max(...Object.keys(historieOmzet).map(Number)) : 0;

  // Gewonnen boekingen per jaar (info).
  const gewonnenPerJaar: Record<number, number> = {};
  for (const b of boekingen) {
    const y = jaarVan(b.offerte_datum) || jaarVan(b.event_datum);
    if (y) gewonnenPerJaar[y] = (gewonnenPerJaar[y] || 0) + (Number(b.waarde) || 0);
  }

  // Kosten per jaar + categorie.
  const kostenPerJaarCat: Record<number, Record<Kostencategorie, number>> = {};
  for (const k of kosten) {
    const y = jaarVan(k.datum) || Number(k.jaar);
    if (!y) continue;
    if (!kostenPerJaarCat[y]) kostenPerJaarCat[y] = legeCategorieMap();
    const cat = (CATEGORIEEN as readonly string[]).includes(k.categorie) ? (k.categorie as Kostencategorie) : 'overig';
    kostenPerJaarCat[y][cat] += Number(k.bedrag) || 0;
  }

  // Bepaal de te tonen jaren: van het vroegste databron-jaar t/m nu.
  const alleJaren = new Set<number>();
  Object.keys(liveOmzet).forEach((y) => alleJaren.add(Number(y)));
  Object.keys(historieOmzet).forEach((y) => alleJaren.add(Number(y)));
  Object.keys(kostenPerJaarCat).forEach((y) => alleJaren.add(Number(y)));
  Object.keys(gewonnenPerJaar).forEach((y) => alleJaren.add(Number(y)));
  const huidigJaar = new Date().getFullYear();
  if (alleJaren.size === 0) alleJaren.add(huidigJaar);
  const minJaar = Math.min(...alleJaren);
  const jarenLijst: number[] = [];
  for (let y = minJaar; y <= huidigJaar; y++) jarenLijst.push(y);

  const waarschuwingen: string[] = [];
  if (kosten.length === 0) {
    waarschuwingen.push(
      'Geen kosten in Directus. Draai syncKostenUitMoneybird(7) met een geldige IJs Moneybird-token (IJS_MONEYBIRD_API_TOKEN).',
    );
  }

  const jaren: JaarRegel[] = [];
  let vorigeOmzet: number | null = null;
  let vorigeMarge: number | null = null;

  for (const jaar of jarenLijst) {
    // Omzet: historie autoritair t/m historieMax, daarboven live.
    let omzet: number;
    let omzet_bron: string;
    if (jaar <= historieMax && historieOmzet[jaar] != null) {
      omzet = historieOmzet[jaar];
      omzet_bron = 'boekhouding (excel)';
    } else if (liveOmzet[jaar] != null) {
      omzet = liveOmzet[jaar];
      omzet_bron = 'facturen + pos (moneybird/zettle)';
    } else if (historieOmzet[jaar] != null) {
      omzet = historieOmzet[jaar];
      omzet_bron = 'boekhouding (excel)';
    } else {
      omzet = 0;
      omzet_bron = 'geen omzetdata';
    }
    omzet = round(omzet);

    const catMap = kostenPerJaarCat[jaar] || legeCategorieMap();
    const kosten_per_categorie = Object.fromEntries(
      (CATEGORIEEN as readonly Kostencategorie[]).map((c) => [c, round(catMap[c])]),
    ) as Record<Kostencategorie, number>;
    const kosten_totaal = round((CATEGORIEEN as readonly Kostencategorie[]).reduce((s, c) => s + catMap[c], 0));

    const marge = round(omzet - kosten_totaal);
    const marge_pct = omzet > 0 ? round((marge / omzet) * 100) : null;

    const omzet_groei_pct = vorigeOmzet && vorigeOmzet > 0 ? round((omzet / vorigeOmzet - 1) * 100) : null;
    const marge_groei_pct = vorigeMarge != null && vorigeMarge !== 0 ? round((marge / vorigeMarge - 1) * 100) : null;
    let trend: JaarRegel['trend'] = null;
    if (omzet_groei_pct != null) trend = omzet_groei_pct > 3 ? 'groei' : omzet_groei_pct < -3 ? 'krimp' : 'stabiel';

    jaren.push({
      jaar,
      omzet,
      omzet_bron,
      kosten_totaal,
      kosten_per_categorie,
      marge,
      marge_pct,
      geboekte_events: round(gewonnenPerJaar[jaar] || 0),
      omzet_groei_pct,
      marge_groei_pct,
      trend,
    });

    vorigeOmzet = omzet;
    vorigeMarge = marge;
  }

  const totOmzet = round(jaren.reduce((s, j) => s + j.omzet, 0));
  const totKosten = round(jaren.reduce((s, j) => s + j.kosten_totaal, 0));
  const catTotaal = legeCategorieMap();
  for (const j of jaren) for (const c of CATEGORIEEN) catTotaal[c] = round(catTotaal[c] + j.kosten_per_categorie[c]);

  return {
    bedrijfId,
    gegenereerd_op: new Date().toISOString(),
    jaren,
    totalen: {
      omzet: totOmzet,
      kosten: totKosten,
      marge: round(totOmzet - totKosten),
      marge_pct: totOmzet > 0 ? round(((totOmzet - totKosten) / totOmzet) * 100) : null,
    },
    kosten_per_categorie_totaal: catTotaal,
    waarschuwingen,
  };
}

// ---------------------------------------------------------------------------
// Groeiadvies (Anthropic)
// ---------------------------------------------------------------------------

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export interface Groeiadvies {
  samenvatting: string;
  adviezen: Array<{ titel: string; advies: string; impact: 'hoog' | 'middel' | 'laag' }>;
  bron_overzicht: ControllerOverzicht;
}

/**
 * Laat Claude op basis van het controller-overzicht 3 tot 5 concrete groeiadviezen
 * schrijven in het Nederlands. Focus: marge per type werk (straatventen via POS vs
 * catering/events via facturen), waar kosten weglekken, en welke maanden onderbenut
 * zijn. Geen koppelstreepjes of em-dashes in de output.
 */
export async function getGroeiadvies(bedrijfId: number): Promise<Groeiadvies> {
  const overzicht = await getControllerOverzicht(bedrijfId);

  // Compacte maand-onderbenutting uit POS (straatventen) voor extra signaal.
  const pos = (await directus.request(
    readItems('POS_Verkopen', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 }),
  )) as any[];
  const omzetPerMaand: Record<string, number> = {};
  for (const p of pos) {
    const m = String(p.verkocht_op || '').slice(5, 7);
    if (m) omzetPerMaand[m] = round((omzetPerMaand[m] || 0) + (Number(p.bedrag) || 0));
  }

  const jaarTabel = overzicht.jaren
    .map(
      (j) =>
        `${j.jaar}: omzet EUR ${j.omzet}, kosten EUR ${j.kosten_totaal} (inkoop ${j.kosten_per_categorie.inkoop}, personeel ${j.kosten_per_categorie.personeel}, wagenpark ${j.kosten_per_categorie.wagenpark}, huur ${j.kosten_per_categorie.huur}, onderhoud ${j.kosten_per_categorie.onderhoud}, overig ${j.kosten_per_categorie.overig}), marge EUR ${j.marge} (${j.marge_pct ?? '-'}%), trend ${j.trend ?? '-'}`,
    )
    .join('\n');

  const prompt = `Je bent de financieel controller en groeiadviseur van IJs uit de Polder, een ambachtelijke ijsonderneming uit Zeewolde. Je krijgt de meerjaren cijfers: omzet, kosten per categorie en marge per jaar. Twee soorten werk: straatventen met de ijskar (losse verkopen via POS) en catering of events (offertes en facturen).

Schrijf 3 tot 5 concrete, scherpe groeiadviezen in het Nederlands. Wees concreet met cijfers uit de data. Denk aan: welke marge per type werk, waar lekken de kosten weg (welke categorie groeit harder dan de omzet), welke maanden zijn onderbenut, en hoe haal je meer marge. Geen open deuren, geen vaag advies.

Belangrijk voor de stijl: gebruik GEEN koppelstreepjes en GEEN gedachtestreepjes of em-dashes. Schrijf met gewone komma's en losse woorden.

CIJFERS PER JAAR:
${jaarTabel}

TOTALEN: omzet EUR ${overzicht.totalen.omzet}, kosten EUR ${overzicht.totalen.kosten}, marge EUR ${overzicht.totalen.marge} (${overzicht.totalen.marge_pct ?? '-'}%).
KOSTEN PER CATEGORIE TOTAAL: ${JSON.stringify(overzicht.kosten_per_categorie_totaal)}.
STRAATVERKOOP (POS) OMZET PER KALENDERMAAND: ${JSON.stringify(omzetPerMaand)}.
${overzicht.waarschuwingen.length ? `LET OP DATAGATEN: ${overzicht.waarschuwingen.join(' ')}` : ''}

Geef ALLEEN JSON terug, exact dit formaat:
{"samenvatting":"een korte alinea","adviezen":[{"titel":"...","advies":"...","impact":"hoog|middel|laag"}]}`;

  const resp = await anthropic.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = resp.content.find((c) => c.type === 'text');
  const raw = text && text.type === 'text' ? text.text : '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Geen JSON in AI-respons voor groeiadvies');
  const parsed = JSON.parse(m[0]);

  const clean = (s: any) => String(s || '').replace(/[‐-―−]/g, ' ').replace(/ - /g, ', ');

  logger.info(`Groeiadvies gegenereerd voor bedrijf ${bedrijfId}: ${(parsed.adviezen || []).length} adviezen`);
  return {
    samenvatting: clean(parsed.samenvatting),
    adviezen: (parsed.adviezen || []).slice(0, 5).map((a: any) => ({
      titel: clean(a.titel),
      advies: clean(a.advies),
      impact: ['hoog', 'middel', 'laag'].includes(a.impact) ? a.impact : 'middel',
    })),
    bron_overzicht: overzicht,
  };
}
