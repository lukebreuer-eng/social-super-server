/**
 * Personeelsbot: wie bellen we voor een klus, en wat zeggen we dan?
 *
 * IJs uit de Polder plant nu per WhatsApp en telefoon. Dat kost avonden, en in
 * het hoogseizoen staat Luke zelf in de bus. Deze module bepaalt wie er voor een
 * klus gebeld moet worden en schrijft het belscript, zodat een uitgaand belletje
 * er alleen nog overheen hoeft.
 *
 * Bewust géén spraakherkenning: een medewerker zit in de auto of op een
 * bouwplaats. Toetsen werkt daar, praten niet.
 */

import { directus } from '../config/directus';
import { readItems, createItem } from '@directus/sdk';
import { logger } from '../utils/logger';

export interface Kandidaat {
  naam: string;
  rol: string;
  score: number;
  reden: string[];
}

export interface Beloproep {
  boeking_id: number;
  datum: string;
  middel: string;
  klant: string;
  kandidaten: Kandidaat[];
  script: string;
  toetsen: Record<string, string>;
}

/** Kan deze persoon dit middel draaien? */
function magDitMiddel(crew: Record<string, unknown>, middel: string): boolean {
  const m = middel.toLowerCase();
  const kunde = JSON.stringify(crew.vaardigheden || []);
  if (m.includes('scooter')) return crew.rijbewijs_scooter === true;
  if (m.includes('bedford')) return kunde.includes('bedford-rijden');
  if (m.includes('kraam') || m.includes('aanhanger')) return kunde.includes('kraam-trekken');
  return true;
}

/**
 * Wie bellen we het eerst? Verkopers vóór de eigenaren, want Luke en Levi
 * hebben overdag genoeg anders te doen; zij zijn het vangnet, niet de eerste keus.
 */
function scoreer(crew: Record<string, unknown>): { score: number; reden: string[] } {
  const reden: string[] = [];
  let score = 50;
  const rol = String(crew.rol || '').toLowerCase();
  const beperking = String(crew.beperkingen || '').toLowerCase();

  if (rol.includes('verkoop')) { score += 30; reden.push('verkoper, eerste keus voor veldwerk'); }
  if (beperking.includes('niet eerste keus')) { score -= 25; reden.push('liever niet als eerste vragen'); }
  if (beperking.includes('geen veld-inzet')) { score -= 100; reden.push('doet geen veldwerk'); }
  if (rol.includes('productie') || rol.includes('administratie')) { score -= 15; reden.push('heeft een andere hoofdtaak'); }

  return { score, reden };
}

/** Stel de beloproep samen voor één boeking. */
export async function maakBeloproep(boekingId: number): Promise<Beloproep | null> {
  const boekingen = (await directus.request(readItems('Boekingen', {
    filter: { id: { _eq: boekingId } } as never, limit: 1,
  }))) as Array<Record<string, unknown>>;
  const boeking = boekingen[0];
  if (!boeking) return null;

  const datum = String(boeking.event_datum || '').slice(0, 10);
  const middel = String(boeking.middel || 'ijskraam');
  const klant = String(boeking.contact_naam || 'een klant');

  const [crew, afwezig] = await Promise.all([
    directus.request(readItems('Crew', {
      filter: { bedrijf: { _eq: 7 }, status: { _eq: 'actief' } }, limit: -1,
    })) as Promise<Array<Record<string, unknown>>>,
    directus.request(readItems('Afwezigheid', { filter: { bedrijf: { _eq: 7 } }, limit: -1 })) as Promise<any[]>,
  ]);

  const weg = new Set(
    afwezig.filter((a) => String(a.van || '') <= datum && datum <= String(a.tot || '')).map((a) => String(a.naam)),
  );

  const kandidaten: Kandidaat[] = crew
    .filter((c) => !weg.has(String(c.naam)) && magDitMiddel(c, middel))
    .map((c) => {
      const { score, reden } = scoreer(c);
      return { naam: String(c.naam), rol: String(c.rol || ''), score, reden };
    })
    .filter((k) => k.score > 0)
    .sort((a, b) => b.score - a.score);

  const dag = datum
    ? new Date(datum).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' })
    : 'een nog onbekende dag';

  const script = `Hoi, met de planning van IJs uit de Polder. `
    + `We zoeken iemand voor ${dag}: ${middel} bij ${klant}. `
    + `Kun jij die dag? Toets 1 als het lukt, toets 2 als het niet lukt, `
    + `of toets 3 als je er later op terug wilt komen.`;

  return {
    boeking_id: boekingId, datum, middel, klant, kandidaten, script,
    toetsen: { '1': 'ja, ik kan', '2': 'nee, lukt niet', '3': 'ik laat het later weten' },
  };
}

/**
 * Welke klussen hebben nog geen bemensing? Dat is de wachtrij voor de bot.
 * Zolang er niet uitgebeld kan worden, is dit gewoon een lijstje om zelf te bellen.
 */
export async function klussenZonderBemensing(dagenVooruit = 21): Promise<Beloproep[]> {
  const vandaag = new Date().toISOString().slice(0, 10);
  const tot = new Date(Date.now() + dagenVooruit * 86400000).toISOString().slice(0, 10);

  const boekingen = (await directus.request(readItems('Boekingen', {
    filter: { bedrijf: { _eq: 7 }, status: { _eq: 'gewonnen' } }, limit: -1,
  }))) as Array<Record<string, unknown>>;

  const binnenkort = boekingen.filter((b) => {
    const d = String(b.event_datum || '').slice(0, 10);
    return d >= vandaag && d <= tot && !b.bemensing;
  });

  const oproepen: Beloproep[] = [];
  for (const b of binnenkort) {
    const oproep = await maakBeloproep(Number(b.id));
    if (oproep) oproepen.push(oproep);
  }

  logger.info(`Personeelsbot: ${oproepen.length} klussen zonder bemensing in de komende ${dagenVooruit} dagen`);
  return oproepen;
}

/** Het antwoord van een medewerker verwerken. */
export async function verwerkAntwoord(boekingId: number, naam: string, toets: string): Promise<{ ok: boolean; bericht: string }> {
  const oproep = await maakBeloproep(boekingId);
  if (!oproep) return { ok: false, bericht: 'die klus ken ik niet' };

  if (toets === '1') {
    await directus.request(createItem('Tasks', {
      title: `${naam} kan ${oproep.datum} — ${oproep.middel} bij ${oproep.klant}`,
      description: `${naam} heeft telefonisch bevestigd beschikbaar te zijn. Zet het definitief in de planning.`,
      bedrijf: 7, status: 'open', priority: 'normal', category: 'planning', assigned_to: 'Luke',
    } as never));
    return { ok: true, bericht: 'Top, ik geef het door. Je hoort nog van ons.' };
  }
  if (toets === '2') {
    return { ok: true, bericht: 'Geen probleem, dan vragen we iemand anders. Fijne dag!' };
  }
  await directus.request(createItem('Tasks', {
    title: `${naam} laat nog weten of ${oproep.datum} lukt`,
    description: `${naam} wil erop terugkomen voor ${oproep.middel} bij ${oproep.klant}. Even navragen.`,
    bedrijf: 7, status: 'open', priority: 'normal', category: 'planning', assigned_to: 'Luke',
  } as never));
  return { ok: true, bericht: 'Prima, laat je het ons weten? Dan houden we hem even open.' };
}
