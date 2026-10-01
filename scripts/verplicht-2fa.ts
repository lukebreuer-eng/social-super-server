/**
 * Maakt tweestapsverificatie verplicht op de policies die toegang geven.
 *
 * Gebruik:
 *   npx tsx scripts/verplicht-2fa.ts            laat zien wat er zou gebeuren
 *   npx tsx scripts/verplicht-2fa.ts --doe-het  voert het uit
 *
 * Let op de volgorde: wie nog geen 2FA heeft ingesteld kan hierna niet meer
 * inloggen tot hij dat doet. Dit script weigert daarom te werken zolang er nog
 * een actieve gebruiker zonder 2FA is.
 */

import dotenv from 'dotenv';
dotenv.config();

const DIRECTUS_URL = process.env.DIRECTUS_URL;
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN;

/** De policies die toegang tot de app geven. De publieke policy blijft met rust. */
const VERPLICHT_OP = ['Administrator', 'Editor Policy', 'Viewer Policy'];

const doeHet = process.argv.includes('--doe-het');

if (!DIRECTUS_URL || !DIRECTUS_TOKEN) {
  console.error('DIRECTUS_URL of DIRECTUS_TOKEN ontbreekt in .env');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${DIRECTUS_TOKEN}`,
};

async function main(): Promise<void> {
  // Eerst de veiligheidscontrole: niemand mag buitengesloten raken.
  const u = await fetch(`${DIRECTUS_URL}/users?fields=first_name,status,tfa_secret&limit=-1`, { headers });
  const gebruikers = (await u.json()).data as Array<{
    first_name?: string; status?: string; tfa_secret?: string | null;
  }>;
  const risico = gebruikers.filter((g) => g.status === 'active' && !g.tfa_secret);

  if (risico.length) {
    console.error('Gestopt. Deze actieve gebruikers hebben nog geen 2FA en zouden buitengesloten raken:');
    risico.forEach((g) => console.error(`  - ${g.first_name}`));
    console.error('Laat ze eerst 2FA instellen, of zet hun account op inactief.');
    process.exit(1);
  }

  const actief = gebruikers.filter((g) => g.status === 'active');
  console.log(`Actieve gebruikers: ${actief.length}, allemaal met 2FA. Veilig om te verplichten.\n`);

  const p = await fetch(`${DIRECTUS_URL}/policies?fields=id,name,enforce_tfa&limit=-1`, { headers });
  const policies = (await p.json()).data as Array<{ id: string; name: string; enforce_tfa?: boolean }>;

  console.log(doeHet ? 'Uitvoeren:\n' : 'PROEFDRAAI, er verandert niets:\n');

  for (const pol of policies) {
    if (!VERPLICHT_OP.includes(pol.name)) { console.log(`  ${pol.name.padEnd(16)} overgeslagen`); continue; }
    if (pol.enforce_tfa) { console.log(`  ${pol.name.padEnd(16)} stond al op verplicht`); continue; }
    if (!doeHet) { console.log(`  ${pol.name.padEnd(16)} zou op verplicht gaan`); continue; }

    const r = await fetch(`${DIRECTUS_URL}/policies/${pol.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ enforce_tfa: true }),
    });
    console.log(r.ok
      ? `  ${pol.name.padEnd(16)} 2FA verplicht`
      : `  ${pol.name.padEnd(16)} MISLUKT: ${r.status} ${await r.text()}`);
  }

  if (!doeHet) console.log('\nKlopt het? Draai dan opnieuw met --doe-het');
}

main().catch((fout) => {
  console.error(fout);
  process.exit(1);
});
