/**
 * Integratie-check: kijkt welke koppelingen (social-OAuth, WordPress) niet werken
 * en zet daar automatisch een taak voor klaar in de Takenlijst, zodat Luke weet
 * welke API-keys hij moet aanvragen om die kanalen aan te zetten. Draait op een
 * cron en is on-demand aan te roepen. Maakt geen dubbele taken aan.
 */

import axios from 'axios';
import { directus } from '../config/directus';
import { env } from '../config/env';
import { readItems, createItem } from '@directus/sdk';
import { logger } from '../utils/logger';

const BEDRIJF_NAAM: Record<number, string> = { 5: 'IP Voice Group', 6: 'IP Voice Shop', 7: 'IJs uit de Polder' };
const naam = (id: number) => BEDRIJF_NAAM[id] || `bedrijf ${id}`;

// platform -> groep + taakomschrijving (per groep één taak per bedrijf)
function groep(platform: string): string {
  const p = String(platform || '').toLowerCase();
  if (p === 'facebook' || p === 'instagram' || p === 'meta') return 'meta';
  return p;
}

function taakVoor(g: string, bedrijfId: number): { title: string; description: string; priority: string } | null {
  const b = naam(bedrijfId);
  switch (g) {
    case 'meta':
      return { title: `Meta-app + OAuth koppelen (Facebook + Instagram) — ${b}`, priority: 'high',
        description: `Auto-publiceren naar Facebook/Instagram werkt nog niet (geen geldige token). Registreer een Meta-app op developers.facebook.com, vraag App ID + App Secret aan en doorloop de OAuth-koppeling voor ${b}.` };
    case 'tiktok':
      return { title: `TikTok Content Posting API koppelen — ${b}`, priority: 'normal',
        description: `TikTok-publicatie faalt (geen geldige token). Vraag toegang aan op developers.tiktok.com (Content Posting API), verkrijg Client Key + Secret en koppel ${b} via OAuth.` };
    case 'linkedin':
      return { title: `LinkedIn OAuth opnieuw koppelen — ${b}`, priority: 'normal',
        description: `LinkedIn-token verlopen of ongeldig. Vernieuw via developer.linkedin.com (Client ID + Secret, scope w_member_social) en doorloop de OAuth-flow voor ${b}.` };
    case 'wordpress':
      return { title: `WordPress app-wachtwoord controleren — ${b}`, priority: 'low',
        description: `WordPress gebruikt een app-wachtwoord (geen OAuth). Controleer of het app-wachtwoord voor ${b} nog geldig is zodat blog-publish blijft werken.` };
    default:
      return null;
  }
}

function heeftGeldigeToken(acc: any): boolean {
  if (!acc.access_token) return false;
  if (acc.token_expires) {
    const exp = new Date(acc.token_expires).getTime();
    if (!isNaN(exp) && exp < Date.now()) return false;
  }
  return true;
}

export interface IntegratieCheckResult { gecontroleerd: number; nieuw: number; bestond_al: number; taken: string[]; }

export async function checkIntegraties(bedrijfId?: number): Promise<IntegratieCheckResult> {
  const accFilter: any = bedrijfId ? { bedrijf: { _eq: bedrijfId } } : {};
  const accounts = (await directus.request(readItems('Social_Accounts', { filter: accFilter, limit: -1 }))) as any[];

  // welke (groep, bedrijf) hebben aandacht nodig?
  const nodig = new Map<string, { g: string; bedrijf: number }>();
  for (const acc of accounts) {
    if (heeftGeldigeToken(acc)) continue;
    const g = groep(acc.platform);
    const b = Number(acc.bedrijf) || 0;
    if (!b || !taakVoor(g, b)) continue;
    nodig.set(`${g}-${b}`, { g, bedrijf: b });
  }

  // bestaande open taken laden voor dedup
  const openTaken = (await directus.request(readItems('Tasks', {
    filter: { status: { _neq: 'done' } } as any, limit: -1, fields: ['id', 'title', 'bedrijf'] as any,
  }))) as any[];
  const heeftTaak = (g: string, b: number) =>
    openTaken.some((t) => Number(t.bedrijf) === b && String(t.title || '').toLowerCase().includes(
      g === 'meta' ? 'meta' : g));

  let nieuw = 0, bestond = 0;
  const gemaakt: string[] = [];
  for (const { g, bedrijf } of nodig.values()) {
    if (heeftTaak(g, bedrijf)) { bestond++; continue; }
    const spec = taakVoor(g, bedrijf)!;
    await directus.request(createItem('Tasks', {
      title: spec.title, description: spec.description, bedrijf, status: 'open',
      priority: spec.priority, category: 'tech', assigned_to: 'Luke',
    } as any));
    nieuw++; gemaakt.push(spec.title);
  }

  // Datakoppelingen: Moneybird en Zettle. Die vallen niet onder Social_Accounts
  // en stonden daardoor buiten elke bewaking. In september 2026 bleek de
  // Moneybird-sleutel al een maand een MCP-token te zijn dat de REST-API
  // weigert; de offerte-, kosten- en factuur-sync faalden stilletjes en niemand
  // zag het omdat een kapotte logstream de waarschuwingen opslokte.
  const datakoppelingen = await checkDatakoppelingen();
  for (const d of datakoppelingen) {
    const sleutel = d.sleutel;
    if (openTaken.some((t) => String(t.title || '').toLowerCase().includes(sleutel))) { bestond++; continue; }
    await directus.request(createItem('Tasks', {
      title: d.title, description: d.beschrijving, bedrijf: 7, status: 'open',
      priority: 'high', category: 'tech', assigned_to: 'Luke',
    } as any));
    nieuw++; gemaakt.push(d.title);
  }

  logger.info(`Integratie-check: ${nodig.size} koppelingen nodig, ${nieuw} nieuwe taken, ${bestond} bestonden al`);
  return { gecontroleerd: accounts.length, nieuw, bestond_al: bestond, taken: gemaakt };
}

interface Datakoppeling { sleutel: string; title: string; beschrijving: string; }

/**
 * Doet één echte call per koppeling. Een sync die "overgeslagen" logt is geen
 * signaal meer zodra niemand de logs leest, dus dit zet er een taak op.
 */
async function checkDatakoppelingen(): Promise<Datakoppeling[]> {
  const kapot: Datakoppeling[] = [];

  const mbToken = env.IJS_MONEYBIRD_API_TOKEN;
  if (!mbToken) {
    kapot.push({
      sleutel: 'moneybird',
      title: 'Moneybird API-token ontbreekt — IJs uit de Polder',
      beschrijving: 'IJS_MONEYBIRD_API_TOKEN staat niet in Coolify. Offerte-, kosten- en factuur-sync draaien daardoor niet.',
    });
  } else {
    try {
      const admin = env.IJS_MONEYBIRD_ADMINISTRATION_ID || '299278260688127925';
      await axios.get(`https://moneybird.com/api/v2/${admin}/estimates.json?per_page=1`, {
        headers: { Authorization: `Bearer ${mbToken}` }, timeout: 15000,
      });
    } catch (error) {
      const body = JSON.stringify((error as any)?.response?.data || {}).slice(0, 200);
      kapot.push({
        sleutel: 'moneybird',
        title: 'Moneybird API-token werkt niet — IJs uit de Polder',
        beschrijving: `De REST-API weigert het token, dus offerte-, kosten- en factuur-sync staan stil. Antwoord van Moneybird: ${body}. Maak een nieuw token via moneybird.com > Instellingen > Koppelingen > API-tokens (let op: een MCP-token werkt hier niet) en zet het als IJS_MONEYBIRD_API_TOKEN in Coolify.`,
      });
    }
  }

  if (!env.ZETTLE_CLIENT_ID || !env.ZETTLE_API_KEY) {
    kapot.push({
      sleutel: 'zettle',
      title: 'Zettle API-sleutel ontbreekt — IJs uit de Polder',
      beschrijving: 'ZETTLE_CLIENT_ID of ZETTLE_API_KEY staat niet in Coolify. De kassaverkopen komen daardoor niet binnen.',
    });
  } else {
    try {
      await axios.post('https://oauth.zettle.com/token', new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        client_id: env.ZETTLE_CLIENT_ID,
        assertion: env.ZETTLE_API_KEY,
      }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
    } catch {
      kapot.push({
        sleutel: 'zettle',
        title: 'Zettle API-sleutel werkt niet — IJs uit de Polder',
        beschrijving: 'Zettle geeft geen access_token meer terug, dus de kassa-omzet loopt achter. Maak een nieuwe sleutel via my.zettle.com > Integraties > API-sleutels (scope READ:PURCHASE) en zet ZETTLE_CLIENT_ID + ZETTLE_API_KEY in Coolify.',
      });
    }
  }

  return kapot;
}
