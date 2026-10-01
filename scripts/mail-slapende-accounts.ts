/**
 * Eenmalig bericht aan de gebruikers van wie het account op inactief gaat.
 *
 * Gebruik:
 *   npx tsx scripts/mail-slapende-accounts.ts              toont wat er verstuurd zou worden
 *   npx tsx scripts/mail-slapende-accounts.ts --verstuur   stuurt het echt
 *
 * Standaard verstuurt dit niets. Je ziet eerst per persoon wat er uit zou gaan,
 * en pas met --verstuur gaat het de deur uit. Het account van de eigenaar wordt
 * overgeslagen: daar draait de engine op.
 */

import dotenv from 'dotenv';
import { Resend } from 'resend';
dotenv.config();

const DIRECTUS_URL = process.env.DIRECTUS_URL;
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Het adres moet het geverifieerde adres uit Resend blijven, anders komt de mail
// niet aan. De naam ervoor is vrij, en die mag Bolletje zijn.
const ADRES = (process.env.RESEND_FROM_EMAIL || 'noreply@ipaudio.nl').replace(/^.*</, '').replace(/>$/, '').trim();
const FROM_EMAIL = `Bolletje <${ADRES}>`;

/** Het account waarop de engine draait; dat blijft actief. */
const EIGENAAR = 'f058e6f0-aa26-4c61-99fa-fb1920dcfb51';

const echtVersturen = process.argv.includes('--verstuur');

if (!DIRECTUS_URL || !DIRECTUS_TOKEN) {
  console.error('DIRECTUS_URL of DIRECTUS_TOKEN ontbreekt in .env');
  process.exit(1);
}
if (echtVersturen && !RESEND_API_KEY) {
  console.error('RESEND_API_KEY ontbreekt in .env, versturen kan niet');
  process.exit(1);
}

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

function bericht(naam: string): { onderwerp: string; html: string; tekst: string } {
  const aanhef = naam ? `Hoi ${naam},` : 'Hoi,';
  const regels = [
    'We hebben de beveiliging van het dashboard en Directus aangescherpt. Accounts waar al maanden niet mee is ingelogd zetten we daarom tijdelijk op inactief, zodat er geen toegang openstaat waar niemand naar omkijkt.',
    'Die van jou is daar een van. Er is niets weggegooid en je gegevens staan er nog gewoon.',
    'Wil je er weer in, laat het even weten, dan zetten we hem binnen een minuut terug. Je stelt dan meteen tweestapsverificatie in, want dat is vanaf nu verplicht.',
  ];
  return {
    onderwerp: 'Je toegang tot het dashboard staat even uit',
    tekst: `${aanhef}\n\n${regels.join('\n\n')}\n\nGroet,\nBolletje\n`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#222;line-height:1.6">
      <p>${aanhef}</p>
      ${regels.map((r) => `<p>${r}</p>`).join('\n      ')}
      <p style="margin-top:24px">Groet,<br><strong>Bolletje</strong></p>
    </div>`,
  };
}

async function main(): Promise<void> {
  const res = await fetch(`${DIRECTUS_URL}/users?fields=id,first_name,email,status&limit=-1`, {
    headers: { Authorization: `Bearer ${DIRECTUS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Gebruikers ophalen mislukt: ${res.status}`);

  const gebruikers = (await res.json()).data as Array<{
    id: string; first_name?: string; email?: string; status?: string;
  }>;

  const ontvangers = gebruikers.filter((g) => g.id !== EIGENAAR && g.email);
  console.log(echtVersturen
    ? `Versturen naar ${ontvangers.length} ontvangers.\n`
    : `PROEFDRAAI, er gaat niets de deur uit. ${ontvangers.length} ontvangers:\n`);

  for (const g of ontvangers) {
    const b = bericht(String(g.first_name || ''));
    if (!echtVersturen) {
      console.log(`--- ${g.email} (status nu: ${g.status}) ---`);
      console.log(`Onderwerp: ${b.onderwerp}`);
      console.log(b.tekst);
      continue;
    }
    try {
      await resend!.emails.send({
        from: FROM_EMAIL, to: [String(g.email)], subject: b.onderwerp, html: b.html, text: b.tekst,
      });
      console.log(`  verstuurd naar ${g.email}`);
    } catch (fout) {
      console.error(`  MISLUKT voor ${g.email}: ${(fout as Error).message}`);
    }
  }

  if (!echtVersturen) console.log('Klopt het? Draai dan opnieuw met --verstuur');
}

main().catch((fout) => {
  console.error(fout);
  process.exit(1);
});
