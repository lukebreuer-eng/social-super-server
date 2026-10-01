/**
 * De Stasis-app: wat er gebeurt zodra er wordt opgenomen.
 *
 * belOpdracht() zet het gesprek op en draagt het kanaal over aan de Asterisk-app
 * "belbot". Zonder iets dat op die app luistert blijft het kanaal in Stasis staan
 * en hoort de ontvanger alleen stilte. Dit bestand is die luisteraar.
 *
 * De verbinding is een websocket naar ARI. Die valt vanzelf een keer weg bij een
 * herstart van Asterisk, dus hij komt zelf weer terug. Zolang hij weg is worden
 * er geen gesprekken afgehandeld, en dat is te zien in de log.
 */

import WebSocket from 'ws';
import axios from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { toetsBinnen } from './belbot';

const APP = 'belbot';

/** Hoe lang we na het bericht nog op een toets wachten. */
const TOETSVENSTER_MS = 12000;

/** Noodrem: een gesprek dat om wat voor reden ook blijft hangen. */
const MAXIMALE_DUUR_MS = 180000;

interface Gesprek {
  opdrachtId: number;
  toets: string;
  afgerond: boolean;
  timers: NodeJS.Timeout[];
}

const gesprekken = new Map<string, Gesprek>();

/**
 * Wat er van een uitgaande oproep terechtkwam.
 *
 * Een kanaal belandt pas in de Stasis-app als er is opgenomen. Om ook te weten
 * dat er niet is opgenomen, abonneren we de app apart op het kanaal; dan komen
 * ook de toestandswisselingen en het einde binnen, met de reden erbij.
 */
export interface Oproepverslag {
  kanaal: string;
  nummer: string;
  omschrijving: string;
  uitgebeld: string;
  opgenomen: string | null;
  beeindigd: string | null;
  rinkelde_seconden: number | null;
  duur_seconden: number | null;
  reden: string | null;
}

const verslagen = new Map<string, Oproepverslag>();
const afgerondeVerslagen: Oproepverslag[] = [];

/** De laatste oproepen, nieuwste eerst. Leeg na een herstart van de engine. */
export function recenteOproepen(): Oproepverslag[] {
  return [...afgerondeVerslagen].reverse().concat([...verslagen.values()].reverse());
}

/** Vanaf nu dit kanaal volgen, ook als er niet wordt opgenomen. */
export async function volgOproep(kanaal: string, nummer: string, omschrijving: string): Promise<void> {
  verslagen.set(kanaal, {
    kanaal, nummer, omschrijving,
    uitgebeld: new Date().toISOString(),
    opgenomen: null, beeindigd: null,
    rinkelde_seconden: null, duur_seconden: null, reden: null,
  });
  try {
    await stuur(`/applications/${APP}/subscription`, { eventSource: `channel:${kanaal}` });
  } catch (error) {
    logger.warn(`Kon oproep ${kanaal} niet volgen: ${(error as Error).message}`);
  }
}

function seconden(van: string, tot: string): number {
  return Math.round((new Date(tot).getTime() - new Date(van).getTime()) / 100) / 10;
}

function oproepOpgenomen(kanaal: string): void {
  const v = verslagen.get(kanaal);
  if (!v || v.opgenomen) return;
  v.opgenomen = new Date().toISOString();
  v.rinkelde_seconden = seconden(v.uitgebeld, v.opgenomen);
}

function oproepBeeindigd(kanaal: string, reden: string): void {
  const v = verslagen.get(kanaal);
  if (!v) return;
  verslagen.delete(kanaal);
  v.beeindigd = new Date().toISOString();
  v.reden = reden || null;
  if (v.opgenomen) v.duur_seconden = seconden(v.opgenomen, v.beeindigd);

  logger.info(v.opgenomen
    ? `Oproep ${v.omschrijving} naar ${v.nummer}: opgenomen na ${v.rinkelde_seconden}s, gesprek duurde ${v.duur_seconden}s.`
    : `Oproep ${v.omschrijving} naar ${v.nummer}: niet opgenomen na ${seconden(v.uitgebeld, v.beeindigd)}s rinkelen (${reden || 'geen reden'}).`);

  afgerondeVerslagen.push(v);
  while (afgerondeVerslagen.length > 50) afgerondeVerslagen.shift();
}

let socket: WebSocket | null = null;
let gestopt = false;
let wachttijd = 2000;

function ari() {
  if (!env.ASTERISK_ARI_URL || !env.ASTERISK_ARI_USER) return null;
  return {
    url: env.ASTERISK_ARI_URL.replace(/\/$/, ''),
    auth: { username: env.ASTERISK_ARI_USER, password: env.ASTERISK_ARI_PASS || '' },
  };
}

async function stuur(pad: string, params?: Record<string, unknown>): Promise<void> {
  const a = ari();
  if (!a) return;
  await axios.post(`${a.url}${pad}`, null, { params, auth: a.auth, timeout: 10000 });
}

async function ophangen(kanaal: string): Promise<void> {
  const a = ari();
  if (!a) return;
  try {
    await axios.delete(`${a.url}/channels/${kanaal}`, { auth: a.auth, timeout: 10000 });
  } catch {
    /* kanaal was al weg; dat is geen fout */
  }
}

function vergeet(kanaal: string): Gesprek | undefined {
  const g = gesprekken.get(kanaal);
  if (g) {
    g.timers.forEach(clearTimeout);
    g.timers = [];
  }
  return g;
}

/** Eén keer de uitkomst wegschrijven, ook als er twee events tegelijk binnenkomen. */
async function rondAf(kanaal: string, opgehangen: boolean): Promise<void> {
  const g = vergeet(kanaal);
  gesprekken.delete(kanaal);
  if (!g || g.afgerond) return;
  g.afgerond = true;
  if (!g.opdrachtId) { logger.info('Losse oproep afgerond.'); return; }
  try {
    await toetsBinnen(g.opdrachtId, g.toets, opgehangen);
    logger.info(`Belopdracht ${g.opdrachtId} afgerond${g.toets ? ` met toets ${g.toets}` : ' zonder toets'}`);
  } catch (error) {
    logger.error(`Uitkomst van belopdracht ${g.opdrachtId} niet kunnen vastleggen:`, error);
  }
}

async function startGesprek(kanaal: string, args: string[]): Promise<void> {
  // Opdracht 0 is een losse oproep: script voorlezen en ophangen, niets vastleggen.
  const opdrachtId = parseInt(args[0] || '', 10);
  const geluid = args[1] || '';
  if (Number.isNaN(opdrachtId) || !geluid) {
    logger.warn(`Gesprek op kanaal ${kanaal} zonder opdracht of geluid; ophangen.`);
    await ophangen(kanaal);
    return;
  }

  const g: Gesprek = { opdrachtId, toets: '', afgerond: false, timers: [] };
  gesprekken.set(kanaal, g);
  g.timers.push(setTimeout(() => { void ophangen(kanaal); }, MAXIMALE_DUUR_MS));

  try {
    await stuur(`/channels/${kanaal}/answer`);
    await stuur(`/channels/${kanaal}/play`, { media: geluid });
    logger.info(opdrachtId
      ? `Belopdracht ${opdrachtId}: bericht gestart op kanaal ${kanaal}`
      : `Losse oproep: script gestart op kanaal ${kanaal}`);
  } catch (error) {
    logger.error(`Belopdracht ${opdrachtId}: bericht afspelen mislukt:`, (error as Error).message);
    await ophangen(kanaal);
  }
}

/** Het bericht is uitgesproken; vanaf nu telt het toetsvenster. */
function berichtKlaar(kanaal: string): void {
  const g = gesprekken.get(kanaal);
  if (!g || g.toets) return;
  if (!g.opdrachtId) { void ophangen(kanaal); return; }
  g.timers.push(setTimeout(() => { void ophangen(kanaal); }, TOETSVENSTER_MS));
}

async function toetsOntvangen(kanaal: string, cijfer: string): Promise<void> {
  const g = gesprekken.get(kanaal);
  if (!g || g.toets) return;
  g.toets = cijfer;
  g.timers.forEach(clearTimeout);
  g.timers = [];
  logger.info(`Belopdracht ${g.opdrachtId}: toets ${cijfer} ontvangen`);
  try {
    await stuur(`/channels/${kanaal}/play`, { media: 'sound:auth-thankyou' });
  } catch {
    /* bedankje is niet belangrijk genoeg om het gesprek op te laten vallen */
  }
  g.timers.push(setTimeout(() => { void ophangen(kanaal); }, 4000));
}

function verwerk(bericht: Record<string, any>): void {
  const kanaal = bericht?.channel?.id as string | undefined;
  switch (bericht?.type) {
    case 'StasisStart':
      if (kanaal) void startGesprek(kanaal, (bericht.args || []) as string[]);
      break;
    case 'PlaybackFinished': {
      const doel = String(bericht?.playback?.target_uri || '');
      const id = doel.startsWith('channel:') ? doel.slice('channel:'.length) : '';
      if (id) berichtKlaar(id);
      break;
    }
    case 'ChannelDtmfReceived':
      if (kanaal) void toetsOntvangen(kanaal, String(bericht.digit || ''));
      break;
    case 'StasisEnd':
      if (kanaal) void rondAf(kanaal, true);
      break;
    case 'ChannelStateChange':
      if (kanaal && String(bericht?.channel?.state) === 'Up') oproepOpgenomen(kanaal);
      break;
    case 'ChannelDestroyed':
      if (kanaal) oproepBeeindigd(kanaal, String(bericht?.cause_txt || ''));
      break;
    default:
      break;
  }
}

function verbind(): void {
  const a = ari();
  if (!a || gestopt) return;

  const basis = a.url.replace(/^http/, 'ws');
  const sleutel = `${a.auth.username}:${a.auth.password}`;
  const adres = `${basis}/events?app=${APP}&subscribeAll=false&api_key=${encodeURIComponent(sleutel)}`;

  socket = new WebSocket(adres);

  socket.on('open', () => {
    wachttijd = 2000;
    logger.info(`Belbot luistert op Asterisk-app "${APP}".`);
  });

  socket.on('message', (ruw) => {
    try {
      verwerk(JSON.parse(String(ruw)));
    } catch (error) {
      logger.warn('Onleesbaar ARI-bericht:', (error as Error).message);
    }
  });

  socket.on('error', (error) => {
    logger.warn(`ARI-websocket fout: ${(error as Error).message}`);
  });

  socket.on('close', () => {
    socket = null;
    if (gestopt) return;
    logger.warn(`Belbot niet meer verbonden met Asterisk; nieuwe poging over ${Math.round(wachttijd / 1000)}s.`);
    setTimeout(verbind, wachttijd);
    wachttijd = Math.min(wachttijd * 2, 60000);
  });
}

/** Aanzetten bij het starten van de engine. Doet niets als Asterisk niet gekoppeld is. */
export function startBelbotStasis(): void {
  if (!ari()) {
    logger.info('Belbot: Asterisk is niet gekoppeld, de Stasis-app blijft uit.');
    return;
  }
  gestopt = false;
  verbind();
}

export function stopBelbotStasis(): void {
  gestopt = true;
  socket?.close();
  socket = null;
}
