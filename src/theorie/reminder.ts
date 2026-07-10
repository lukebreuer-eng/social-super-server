import { Resend } from 'resend';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Dagelijkse theorie-reminder voor Miles' bromfiets-examen.
 *
 * Draait elke avond via cron. Kijkt of Miles vandaag geoefend heeft in de
 * Theorie Sidekick en stuurt Luke een korte mail: een schouderklopje als het
 * gelukt is, een por als het er nog niet van kwam. Stopt automatisch zodra
 * het examen geweest is (MILES_THEORIE_EXAMEN).
 */

const GEBRUIKER = 'miles';
const APP_URL = 'https://api.ipaudio.nl/theorie';

// Nette labels per categorie-sleutel uit de vragenbank.
const CATEGORIE_LABELS: Record<string, string> = {
  verkeerstekens: 'Verkeerstekens',
  voorrang: 'Voorrang',
  gebruik_weg: 'Gebruik van de weg',
  gevaarherkenning: 'Gevaarherkenning',
  veilig: 'Veilig rijden',
  wetgeving: 'Wetgeving',
  bijzondere: 'Bijzondere situaties',
};

function labelVoor(sleutel: string): string {
  return CATEGORIE_LABELS[sleutel] || sleutel;
}

/** Datum-string (YYYY-MM-DD) van een tijdstip, in Amsterdamse tijd. */
function amsterdamDatum(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
}

/** Aantal hele dagen tussen vandaag en de examendatum (Amsterdam). */
function dagenTotExamen(vandaagStr: string): number {
  const examen = new Date(`${env.MILES_THEORIE_EXAMEN}T00:00:00+02:00`);
  const vandaag = new Date(`${vandaagStr}T00:00:00+02:00`);
  return Math.round((examen.getTime() - vandaag.getTime()) / 86_400_000);
}

interface Poging {
  categorie: string;
  correct: boolean;
  date_created: string;
}

export async function stuurTheorieReminder(): Promise<void> {
  if (!env.RESEND_API_KEY) {
    logger.warn('[theorie-reminder] geen RESEND_API_KEY, reminder overgeslagen');
    return;
  }

  const vandaagStr = amsterdamDatum(new Date());
  const dagen = dagenTotExamen(vandaagStr);

  // Examen geweest? Dan stopt de reminder vanzelf.
  if (dagen < 0) {
    logger.info('[theorie-reminder] examen is geweest, geen reminder meer');
    return;
  }

  const { readItems } = await import('@directus/sdk');
  const { directus } = await import('../config/directus');

  const pogingen = (await directus.request(
    readItems('Theorie_Pogingen', {
      filter: { gebruiker: { _eq: GEBRUIKER } } as any,
      sort: ['-date_created'] as any,
      fields: ['categorie', 'correct', 'date_created'] as any,
      limit: 5000,
    }),
  )) as unknown as Poging[];

  // Vandaag geoefend?
  const vandaagPogingen = pogingen.filter(
    (p) => amsterdamDatum(new Date(p.date_created)) === vandaagStr,
  );
  const geoefendVandaag = vandaagPogingen.length;
  const goedVandaag = vandaagPogingen.filter((p) => p.correct).length;
  const pctVandaag =
    geoefendVandaag > 0 ? Math.round((goedVandaag / geoefendVandaag) * 100) : 0;

  // Zwakste categorie (alleen tellen bij genoeg data).
  const perCat: Record<string, { totaal: number; goed: number }> = {};
  for (const p of pogingen) {
    const c = perCat[p.categorie] || { totaal: 0, goed: 0 };
    c.totaal += 1;
    if (p.correct) c.goed += 1;
    perCat[p.categorie] = c;
  }
  let zwakste: { cat: string; pct: number } | null = null;
  for (const [cat, v] of Object.entries(perCat)) {
    if (v.totaal < 15) continue;
    const pct = Math.round((v.goed / v.totaal) * 100);
    if (!zwakste || pct < zwakste.pct) zwakste = { cat, pct };
  }

  const resend = new Resend(env.RESEND_API_KEY);
  const from = env.RESEND_FROM_EMAIL || 'Theorie Sidekick <luke@ipvoicegroup.com>';
  const to = env.THEORIE_REMINDER_TO || env.ADMIN_EMAIL || 'luke.breuer@gmail.com';

  const dagLabel = dagen === 0 ? 'vandaag' : dagen === 1 ? 'nog 1 dag' : `nog ${dagen} dagen`;
  const zwakRegel = zwakste
    ? `Zwakste onderwerp nu: <strong>${labelVoor(zwakste.cat)}</strong> (${zwakste.pct}% goed). Daar liggen de makkelijkste punten.`
    : '';

  let onderwerp: string;
  let kop: string;
  let boodschap: string;

  if (geoefendVandaag > 0) {
    onderwerp = `Miles oefende vandaag ${geoefendVandaag} vragen (${pctVandaag}%) - ${dagLabel} tot het examen`;
    kop = 'Goed bezig vandaag';
    boodschap = `Miles heeft vandaag <strong>${geoefendVandaag} vragen</strong> gedaan met <strong>${pctVandaag}% goed</strong>. Lekker doorpakken, elke dag een setje houdt het scherp.`;
  } else {
    onderwerp = `Miles heeft vandaag nog niet geoefend - ${dagLabel} tot het examen`;
    kop = 'Vandaag nog niet geoefend';
    boodschap = `Miles heeft vandaag nog geen vragen gedaan. Eén setje van 10 duurt maar 2 minuten. Stuur 'm er even naartoe.`;
  }

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a2e;">
      <h2 style="margin: 0 0 4px;">${kop}</h2>
      <p style="color: #666; margin: 0 0 20px;">Bromfiets-theorie · examen ${env.MILES_THEORIE_EXAMEN} (${dagLabel})</p>
      <p style="font-size: 15px; line-height: 1.5;">${boodschap}</p>
      ${zwakRegel ? `<p style="font-size: 15px; line-height: 1.5;">${zwakRegel}</p>` : ''}
      <p style="margin: 24px 0;">
        <a href="${APP_URL}"
           style="background: #FF6B35; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">
          Open de Theorie Sidekick
        </a>
      </p>
      <p style="color: #999; font-size: 12px;">Automatische dagelijkse reminder tot het examen.</p>
    </div>
  `;

  const tekst = `${kop}\n\n${boodschap.replace(/<[^>]+>/g, '')}\n${
    zwakste ? `Zwakste onderwerp: ${labelVoor(zwakste.cat)} (${zwakste.pct}%).\n` : ''
  }\nExamen ${env.MILES_THEORIE_EXAMEN} (${dagLabel}).\nOefenen: ${APP_URL}`;

  await resend.emails.send({ from, to, subject: onderwerp, html, text: tekst });
  logger.info(
    `[theorie-reminder] mail naar ${to} verstuurd (vandaag=${geoefendVandaag} vragen, ${dagLabel})`,
  );
}
