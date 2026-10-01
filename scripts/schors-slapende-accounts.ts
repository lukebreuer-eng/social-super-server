/**
 * Zet de accounts op inactief waar al maanden niet mee is ingelogd.
 *
 * Gebruik:
 *   npx tsx scripts/schors-slapende-accounts.ts            laat zien wat er zou gebeuren
 *   npx tsx scripts/schors-slapende-accounts.ts --doe-het  voert het uit
 *
 * Suspended betekent: niet meer kunnen inloggen. Er wordt niets verwijderd en
 * het is met één handeling terug te draaien. Het account waarop de engine
 * draait blijft actief, anders valt alles stil.
 */

import dotenv from 'dotenv';
dotenv.config();

const DIRECTUS_URL = process.env.DIRECTUS_URL;
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN;

/** Het account waarop de engine draait. */
const EIGENAAR = 'f058e6f0-aa26-4c61-99fa-fb1920dcfb51';

/** Zo lang niet ingelogd en je gaat op inactief. */
const DAGEN_SLAPEND = 30;

const doeHet = process.argv.includes('--doe-het');

if (!DIRECTUS_URL || !DIRECTUS_TOKEN) {
  console.error('DIRECTUS_URL of DIRECTUS_TOKEN ontbreekt in .env');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${DIRECTUS_TOKEN}`,
};

function dagenGeleden(stempel?: string | null): number | null {
  if (!stempel) return null;
  return Math.floor((Date.now() - new Date(stempel).getTime()) / 86400000);
}

async function main(): Promise<void> {
  const res = await fetch(`${DIRECTUS_URL}/users?fields=id,first_name,status,last_access&limit=-1`, { headers });
  if (!res.ok) throw new Error(`Gebruikers ophalen mislukt: ${res.status}`);

  const gebruikers = (await res.json()).data as Array<{
    id: string; first_name?: string; status?: string; last_access?: string | null;
  }>;

  console.log(doeHet ? 'Uitvoeren:\n' : 'PROEFDRAAI, er verandert niets:\n');

  for (const g of gebruikers) {
    const naam = String(g.first_name || g.id);
    const dagen = dagenGeleden(g.last_access);
    const beschrijving = dagen === null ? 'nooit ingelogd' : `${dagen} dagen geleden`;

    if (g.id === EIGENAAR) { console.log(`  ${naam.padEnd(9)} blijft actief (hier draait de engine op)`); continue; }
    if (g.status !== 'active') { console.log(`  ${naam.padEnd(9)} staat al op ${g.status}`); continue; }
    if (dagen !== null && dagen < DAGEN_SLAPEND) { console.log(`  ${naam.padEnd(9)} blijft actief (${beschrijving})`); continue; }

    if (!doeHet) { console.log(`  ${naam.padEnd(9)} zou op suspended gaan (${beschrijving})`); continue; }

    const r = await fetch(`${DIRECTUS_URL}/users/${g.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ status: 'suspended' }),
    });
    console.log(r.ok
      ? `  ${naam.padEnd(9)} op suspended gezet (${beschrijving})`
      : `  ${naam.padEnd(9)} MISLUKT: ${r.status} ${await r.text()}`);
  }

  if (!doeHet) console.log('\nKlopt het? Draai dan opnieuw met --doe-het');
}

main().catch((fout) => {
  console.error(fout);
  process.exit(1);
});
