/**
 * De kant van de Social Engine die Asterisk aanstuurt.
 *
 * Per belopdracht: tekst door TTS halen, Asterisk laten bellen, wachten op een
 * toets, en de uitkomst terugschrijven. Asterisk registreert als SIP-toestel op
 * de MiVoice Business, dus het gesprek loopt via de bestaande routing.
 *
 * Doet niets zolang ASTERISK_ARI_URL leeg is; dan blijft de wachtrij gewoon een
 * afbellijst die met de hand afgewerkt kan worden.
 */

import { writeFile } from 'fs/promises';
import axios from 'axios';
import { directus } from '../config/directus';
import { readItems, updateItem } from '@directus/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { verwerkUitkomst } from './belmotor';

const GELUIDSMAP = '/var/lib/asterisk/sounds/bot';

function ariBasis(): { url: string; auth: { username: string; password: string } } | null {
  if (!env.ASTERISK_ARI_URL || !env.ASTERISK_ARI_USER) return null;
  return {
    url: env.ASTERISK_ARI_URL.replace(/\/$/, ''),
    auth: { username: env.ASTERISK_ARI_USER, password: env.ASTERISK_ARI_PASS || '' },
  };
}

/**
 * Tekst naar een geluidsbestand dat Asterisk kan afspelen.
 *
 * OpenAI levert geen 8 kHz maar 24 kHz. Asterisk speelt een wav alleen af op
 * 8 kHz, dus een wav van OpenAI blijft stil. Daarom vragen we kale pcm op en
 * schrijven we .sln24: dat is precies wat er binnenkomt, 24 kHz mono 16 bits,
 * en Asterisk rekent het zelf om naar wat de lijn aankan.
 */
export async function maakGeluid(tekst: string, bestandsnaam: string): Promise<string | null> {
  if (!env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) return null;
  try {
    const { data } = await axios.post(
      'https://api.openai.com/v1/audio/speech',
      { model: 'gpt-4o-mini-tts', voice: 'alloy', input: tekst, response_format: 'pcm', speed: 0.95 },
      { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, responseType: 'arraybuffer', timeout: 45000 },
    );
    const pad = `${GELUIDSMAP}/${bestandsnaam}.sln24`;
    await writeFile(pad, Buffer.from(data));
    return `sound:bot/${bestandsnaam}`;
  } catch (error) {
    logger.warn(`TTS mislukt voor ${bestandsnaam}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Van E.164 naar het formaat dat de MiVoice Business accepteert.
 *
 * De centrale verwacht een nationaal nummer zoals een toestel het zou kiezen:
 * 0620435467. Een INVITE naar 0031620435467 beantwoordt zij met 404 Not Found,
 * ook al klopt de rest van de oproep. Buitenlandse nummers houden 00.
 */
export function kiesnummer(nummer: string): string {
  const n = String(nummer || '').replace(/[^\d+]/g, '');
  if (n.startsWith('+31')) return `0${n.slice(3)}`;
  if (n.startsWith('0031')) return `0${n.slice(4)}`;
  if (n.startsWith('+')) return `00${n.slice(1)}`;
  return n;
}

export interface BelResultaat { gebeld: boolean; reden?: string; kanaal?: string }

/** Zet één gesprek op. De afhandeling loopt verder via de Stasis-app in Asterisk. */
export async function belOpdracht(opdrachtId: number): Promise<BelResultaat> {
  const ari = ariBasis();
  if (!ari) return { gebeld: false, reden: 'Asterisk is nog niet gekoppeld' };

  const rijen = (await directus.request(readItems('Belopdrachten', {
    filter: { id: { _eq: opdrachtId } } as never, limit: 1,
  }))) as Array<Record<string, unknown>>;
  const o = rijen[0];
  if (!o) return { gebeld: false, reden: 'opdracht bestaat niet' };
  if (o.status !== 'wacht') return { gebeld: false, reden: `staat al op ${o.status}` };

  // Zonder beller-ID zet Asterisk "Anonymous" in de From en antwoordt de MiVoice
  // Business met 404 Not Found. Dat is aan niets anders te zien, dus hier stoppen
  // met een leesbare reden in plaats van een gesprek dat stilletjes mislukt.
  if (!env.SIP_CALLERID) {
    logger.error('SIP_CALLERID ontbreekt; de centrale weigert anonieme oproepen.');
    return { gebeld: false, reden: 'SIP_CALLERID ontbreekt in de omgeving' };
  }

  const geluid = await maakGeluid(String(o.script), `opdracht-${opdrachtId}`);
  if (!geluid) return { gebeld: false, reden: 'kon het geluid niet maken' };

  await directus.request(updateItem('Belopdrachten', opdrachtId, { status: 'bezig' } as never));

  try {
    const { data } = await axios.post(`${ari.url}/channels`, null, {
      params: {
        endpoint: `PJSIP/${kiesnummer(String(o.telefoon))}@mivb`,
        app: 'belbot',
        appArgs: `${opdrachtId},${geluid}`,
        callerId: env.SIP_CALLERID,
        timeout: 45,
      },
      auth: ari.auth, timeout: 20000,
    });
    logger.info(`Belopdracht ${opdrachtId}: gesprek opgezet naar ${o.telefoon} (kanaal ${data.id})`);
    return { gebeld: true, kanaal: data.id };
  } catch (error) {
    await directus.request(updateItem('Belopdrachten', opdrachtId, { status: 'wacht' } as never));
    const reden = (error as any)?.response?.data?.message || (error as Error).message;
    logger.warn(`Belopdracht ${opdrachtId} kon niet gebeld worden: ${reden}`);
    return { gebeld: false, reden };
  }
}

/** Werkt de wachtrij af; bedoeld voor een cron tijdens kantooruren. */
export async function werkWachtrijAf(bedrijfId: number, maximaal = 5): Promise<{ gebeld: number; overgeslagen: number }> {
  if (!ariBasis()) return { gebeld: 0, overgeslagen: 0 };

  const uur = new Date().getHours();
  if (uur < 9 || uur >= 20) {
    logger.info('Belwachtrij: buiten belvenster (9:00-20:00), niets gebeld');
    return { gebeld: 0, overgeslagen: 0 };
  }

  const rij = (await directus.request(readItems('Belopdrachten', {
    filter: { bedrijf: { _eq: bedrijfId }, status: { _eq: 'wacht' } } as never,
    limit: maximaal, sort: ['gepland_op'],
  }))) as Array<{ id: number }>;

  let gebeld = 0, overgeslagen = 0;
  for (const o of rij) {
    const r = await belOpdracht(o.id);
    if (r.gebeld) gebeld++; else overgeslagen++;
    await new Promise((r2) => setTimeout(r2, 3000));
  }
  return { gebeld, overgeslagen };
}

/** Asterisk meldt terug welke toets er gedrukt is. */
export async function toetsBinnen(opdrachtId: number, toets: string, opgehangen: boolean): Promise<void> {
  await verwerkUitkomst(opdrachtId, {
    status: opgehangen && !toets ? 'geen_gehoor' : 'gebeld',
    antwoord: toets || undefined,
  });
}


/**
 * Staat de telefoonlijn overeind?
 *
 * Bewust zichtbaar in het dashboard: een SIP-registratie die stilletjes wegvalt
 * is precies het soort storing dat maanden onopgemerkt blijft. In juli 2026 lag
 * de doorschakeling van Bolletje er weken uit zonder dat iemand het zag.
 */
export async function belbotStatus(): Promise<{
  gekoppeld: boolean; ari: boolean; registratie: string | null; endpoint: string | null; melding: string;
}> {
  const ari = ariBasis();
  if (!ari) {
    return {
      gekoppeld: false, ari: false, registratie: null, endpoint: null,
      melding: 'Asterisk is nog niet gekoppeld. De wachtrij is nu een afbellijst die je zelf afwerkt.',
    };
  }
  try {
    await axios.get(`${ari.url}/asterisk/info`, { auth: ari.auth, timeout: 6000 });
    let registratie: string | null = null;
    let endpoint: string | null = null;
    try {
      const { data } = await axios.get(`${ari.url}/endpoints`, { auth: ari.auth, timeout: 6000 });
      const mivb = (Array.isArray(data) ? data : []).find((e: any) => String(e.resource || '').includes('mivb'));
      endpoint = mivb ? String(mivb.state) : null;
      registratie = endpoint === 'online' ? 'geregistreerd' : endpoint;
    } catch { /* endpoints opvragen kan falen zonder dat ARI stuk is */ }

    const goed = endpoint === 'online';
    return {
      gekoppeld: true, ari: true, registratie, endpoint,
      melding: goed
        ? 'De telefoonlijn staat en de belbot kan uitbellen.'
        : `Asterisk draait, maar de registratie op de centrale is ${endpoint || 'onbekend'}. Er kan nu niet gebeld worden.`,
    };
  } catch (error) {
    return {
      gekoppeld: true, ari: false, registratie: null, endpoint: null,
      melding: `Asterisk is niet bereikbaar: ${(error as Error).message}. Er kan nu niet gebeld worden.`,
    };
  }
}
