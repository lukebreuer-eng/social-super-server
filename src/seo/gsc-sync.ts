/**
 * Google Search Console sync.
 *
 * Haalt de echte zoekdata (queries, impressies, clicks, positie) op uit GSC
 * per bedrijf en zet die in Directus (GSC_Keywords). Verrijkt vervolgens de
 * Content Map (Cluster_Topics.zoekvolume) met echte impressie-cijfers, en
 * levert "kansen" op: queries waar de site al impressies voor krijgt maar nog
 * niet goed op rankt (positie > 5) — direct bruikbaar voor de content-engine.
 *
 * Auth: service-account JWT (RS256) -> access_token. Geen extra dependency:
 * we tekenen de JWT zelf met Node crypto, zoals bij Zettle.
 *
 * Nodig in env:
 *   GSC_SERVICE_ACCOUNT_JSON  = de volledige service-account JSON (1 regel)
 * En per bedrijf in Directus (Bedrijven.gsc_site_url), bv:
 *   https://ijsuitdepolder.nl/   (URL-prefix property)
 *   sc-domain:ipvoicegroup.nl    (domain property)
 */

import crypto from 'crypto';
import axios from 'axios';
import { directus } from '../config/directus';
import { readItems, updateItem, createItem, deleteItems } from '@directus/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const API_BASE = 'https://searchconsole.googleapis.com/webmasters/v3';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface GscRow {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  positie: number;
}

let tokenCache: { token: string; exp: number } | null = null;

function loadServiceAccount(): ServiceAccount | null {
  const raw = env.GSC_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw) as ServiceAccount;
    if (!sa.client_email || !sa.private_key) return null;
    // Coolify/.env kan \n als letterlijke tekst opslaan -> herstel echte newlines
    sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    return sa;
  } catch (e) {
    logger.error(`GSC: kon GSC_SERVICE_ACCOUNT_JSON niet parsen: ${(e as Error).message}`);
    return null;
  }
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** Teken een service-account JWT en wissel die in voor een access_token (gecached). */
async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.exp > now + 60) return tokenCache.token;

  const sa = loadServiceAccount();
  if (!sa) throw new Error('GSC service-account ontbreekt of is ongeldig (GSC_SERVICE_ACCOUNT_JSON)');

  const aud = sa.token_uri || TOKEN_URI;
  const claim = { iss: sa.client_email, scope: SCOPE, aud, exp: now + 3600, iat: now };
  const signingInput = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claim)}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(sa.private_key, 'base64url');
  const assertion = `${signingInput}.${signature}`;

  const res = await axios.post(
    aud,
    new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const token = res.data.access_token as string;
  tokenCache = { token, exp: now + (Number(res.data.expires_in) || 3600) };
  return token;
}

/** Is de GSC-koppeling geconfigureerd? */
export function gscConfigured(): boolean {
  return !!loadServiceAccount();
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Rauwe Search Analytics query per query-dimensie over de afgelopen N dagen. */
export async function fetchGscQueries(siteUrl: string, dagen = 90, rowLimit = 1000): Promise<GscRow[]> {
  const token = await getAccessToken();
  const end = new Date();
  const start = new Date(end.getTime() - dagen * 86400000);
  const url = `${API_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const res = await axios.post(
    url,
    { startDate: ymd(start), endDate: ymd(end), dimensions: ['query'], rowLimit },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  const rows = (res.data.rows || []) as Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }>;
  return rows.map((r) => ({
    query: r.keys[0],
    clicks: Math.round(r.clicks),
    impressions: Math.round(r.impressions),
    ctr: Math.round(r.ctr * 1000) / 10, // %
    positie: Math.round(r.position * 10) / 10,
  }));
}

/** Het GSC-property-adres voor een bedrijf (Bedrijven.gsc_site_url, fallback website + '/'). */
async function siteUrlVoorBedrijf(bedrijfId: number): Promise<string | null> {
  const rows = (await directus.request(
    readItems('Bedrijven', { filter: { id: { _eq: bedrijfId } }, fields: ['id', 'website', 'gsc_site_url'], limit: 1 })
  )) as any[];
  const b = rows[0];
  if (!b) return null;
  if (b.gsc_site_url) return String(b.gsc_site_url);
  if (b.website) return String(b.website).replace(/\/?$/, '/');
  return null;
}

export interface GscSyncResult {
  bedrijfId: number;
  site: string;
  queries: number;
  totaal_impressies: number;
  totaal_clicks: number;
  topic_volumes_bijgewerkt: number;
}

/**
 * Sync GSC voor één bedrijf: schrijft snapshot naar GSC_Keywords (replace),
 * en vult Cluster_Topics.zoekvolume met echte impressies waar de keyword matcht.
 */
export async function syncGscVoorBedrijf(bedrijfId: number, dagen = 90): Promise<GscSyncResult> {
  const site = await siteUrlVoorBedrijf(bedrijfId);
  if (!site) throw new Error(`Geen GSC site_url voor bedrijf ${bedrijfId}`);

  const rows = await fetchGscQueries(site, dagen);
  logger.info(`GSC bedrijf ${bedrijfId} (${site}): ${rows.length} queries opgehaald`);

  // Snapshot vervangen: oude rijen van dit bedrijf weg, nieuwe erin.
  const oude = (await directus.request(
    readItems('GSC_Keywords', { filter: { bedrijf: { _eq: bedrijfId } }, fields: ['id'], limit: -1 })
  )) as any[];
  if (oude.length) {
    await directus.request(deleteItems('GSC_Keywords', oude.map((o) => o.id)));
  }
  const vandaag = ymd(new Date());
  for (const r of rows) {
    await directus.request(
      createItem('GSC_Keywords', {
        bedrijf: bedrijfId,
        query: r.query,
        clicks: r.clicks,
        impressies: r.impressions,
        ctr: r.ctr,
        positie: r.positie,
        periode_dagen: dagen,
        date_synced: vandaag,
      } as any)
    );
  }

  // Content Map verrijken: zoekvolume vullen met echte impressies waar keyword == query.
  const topics = (await directus.request(
    readItems('Cluster_Topics', { filter: { bedrijf: { _eq: bedrijfId } }, fields: ['id', 'keyword', 'zoekvolume'], limit: -1 })
  )) as any[];
  const norm = (s: string) => String(s || '').toLowerCase().trim();
  const byQuery = new Map(rows.map((r) => [norm(r.query), r.impressions]));
  let bijgewerkt = 0;
  for (const t of topics) {
    const imp = byQuery.get(norm(t.keyword));
    if (imp != null && imp !== t.zoekvolume) {
      await directus.request(updateItem('Cluster_Topics', t.id, { zoekvolume: imp } as any));
      bijgewerkt++;
    }
  }

  return {
    bedrijfId,
    site,
    queries: rows.length,
    totaal_impressies: rows.reduce((s, r) => s + r.impressions, 0),
    totaal_clicks: rows.reduce((s, r) => s + r.clicks, 0),
    topic_volumes_bijgewerkt: bijgewerkt,
  };
}

export interface GscKans {
  query: string;
  impressies: number;
  clicks: number;
  positie: number;
  reden: string;
}

/**
 * Content-kansen uit GSC: queries met serieuze impressies maar zwakke positie
 * (pagina 2+) of veel impressies met lage CTR. Dat zijn de queries waar nieuwe
 * of betere content direct verkeer oplevert.
 */
export async function getGscKansen(bedrijfId: number, limit = 25): Promise<GscKans[]> {
  const rows = (await directus.request(
    readItems('GSC_Keywords', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 })
  )) as any[];

  const kansen: GscKans[] = [];
  for (const r of rows) {
    const impressies = Number(r.impressies) || 0;
    const positie = Number(r.positie) || 0;
    const clicks = Number(r.clicks) || 0;
    if (impressies < 10) continue;
    let reden = '';
    if (positie > 10) reden = `pagina 2+ (positie ${positie}) — content/links nodig`;
    else if (positie > 4) reden = `onderaan pagina 1 (positie ${positie}) — net geen top 3`;
    else if (clicks === 0) reden = `top posities maar 0 clicks — titel/snippet verbeteren`;
    if (!reden) continue;
    kansen.push({ query: r.query, impressies, clicks, positie, reden });
  }
  // Sorteer op potentieel: impressies eerst.
  kansen.sort((a, b) => b.impressies - a.impressies);
  return kansen.slice(0, limit);
}

/** Simpele intent-gok op basis van het zoekwoord. */
function gokIntent(query: string): string {
  const q = query.toLowerCase();
  if (/(huren|huur|prijs|kosten|offerte|boeken|bestellen|kopen)/.test(q)) return 'commercial';
  if (/(zeewolde|almere|vathorst|amersfoort|polder|flevoland|locatie|bij mij|in de buurt)/.test(q)) return 'local';
  return 'informational';
}

/**
 * Maakt van een GSC-kans (een zoekwoord waar je net te laag op rankt) automatisch
 * een Content Map-topic en zet meteen een blog in de wachtrij. Eén klik vanuit het
 * Speurder-dashboard. Hergebruikt een bestaand topic als het zoekwoord er al is.
 */
export async function kansNaarPagina(bedrijfId: number, query: string, impressies?: number): Promise<{ topicId: number; keyword: string; hergebruikt: boolean }> {
  const keyword = String(query || '').trim();
  if (!keyword) throw new Error('Lege query');

  // Bestaat dit zoekwoord al als topic? Dan hergebruiken.
  const bestaande = (await directus.request(
    readItems('Cluster_Topics', { filter: { bedrijf: { _eq: bedrijfId }, keyword: { _eq: keyword } }, fields: ['id', 'keyword'], limit: 1 })
  )) as any[];
  let topicId: number;
  let hergebruikt = false;
  if (bestaande.length) {
    topicId = Number(bestaande[0].id);
    hergebruikt = true;
  } else {
    // Doelcluster: liefst een "kansen"-cluster, anders de eerste, anders er een maken.
    const clusters = (await directus.request(
      readItems('Content_Clusters', { filter: { bedrijf: { _eq: bedrijfId }, status: { _neq: 'archived' } }, sort: ['sort', 'id'], fields: ['id', 'thema'], limit: -1 })
    )) as any[];
    let cluster = clusters.find((c) => /kans|gsc|lokaal|local/i.test(String(c.thema || '')));
    if (!cluster) cluster = clusters[0];
    let clusterId: number;
    if (cluster) {
      clusterId = Number(cluster.id);
    } else {
      const nieuw = (await directus.request(
        createItem('Content_Clusters', { bedrijf: bedrijfId, status: 'published', thema: 'SEO kansen (GSC)', pillar_keyword: keyword, omschrijving: 'Automatisch gevuld met zoekwoorden uit Google Search Console waar we net te laag op ranken.' } as any)
      )) as any;
      clusterId = Number(nieuw.id);
    }
    const topic = (await directus.request(
      createItem('Cluster_Topics', {
        cluster: clusterId, bedrijf: bedrijfId, keyword, type: 'supporting',
        intent: gokIntent(keyword), zoekvolume: impressies ?? null, status: 'planned',
      } as any)
    )) as any;
    topicId = Number(topic.id);
  }

  const { generateBlogForTopic } = await import('./content-map');
  await generateBlogForTopic(topicId);
  return { topicId, keyword, hergebruikt };
}

export interface GscOverzicht {
  geconfigureerd: boolean;
  totaal_queries: number;
  totaal_impressies: number;
  totaal_clicks: number;
  gem_positie: number | null;
  top_queries: GscRow[];
  kansen: GscKans[];
  laatste_sync: string | null;
}

/** Dashboard-overzicht GSC per bedrijf (leest snapshot uit Directus). */
export async function getGscOverzicht(bedrijfId: number): Promise<GscOverzicht> {
  const rows = (await directus.request(
    readItems('GSC_Keywords', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 })
  )) as any[];
  if (!rows.length) {
    return {
      geconfigureerd: gscConfigured(),
      totaal_queries: 0, totaal_impressies: 0, totaal_clicks: 0, gem_positie: null,
      top_queries: [], kansen: [], laatste_sync: null,
    };
  }
  const totaal_impressies = rows.reduce((s, r) => s + (Number(r.impressies) || 0), 0);
  const totaal_clicks = rows.reduce((s, r) => s + (Number(r.clicks) || 0), 0);
  const gewPositie = rows.reduce((s, r) => s + (Number(r.positie) || 0) * (Number(r.impressies) || 0), 0);
  const top_queries: GscRow[] = rows
    .map((r) => ({ query: r.query, clicks: Number(r.clicks) || 0, impressions: Number(r.impressies) || 0, ctr: Number(r.ctr) || 0, positie: Number(r.positie) || 0 }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 15);
  return {
    geconfigureerd: true,
    totaal_queries: rows.length,
    totaal_impressies,
    totaal_clicks,
    gem_positie: totaal_impressies ? Math.round((gewPositie / totaal_impressies) * 10) / 10 : null,
    top_queries,
    kansen: await getGscKansen(bedrijfId),
    laatste_sync: rows[0]?.date_synced || null,
  };
}
