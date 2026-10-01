/**
 * Seed script: maakt de collectie Belgeschiedenis aan.
 *
 * Gebruik:  npx tsx scripts/seed-belgeschiedenis.ts
 *
 * Leest DIRECTUS_URL en DIRECTUS_TOKEN uit .env.
 *
 * Elke uitgaande oproep van de belbot komt hier te staan: of er is opgenomen,
 * hoe lang het rinkelde, hoe lang het gesprek duurde en wat de uitkomst was.
 * De wachtrij (Belopdrachten) zegt wat er gebeld moet worden, dit zegt wat
 * er daadwerkelijk gebeurd is. Het script is herhaalbaar: wat er al staat
 * blijft staan.
 */

import dotenv from 'dotenv';
dotenv.config();

const DIRECTUS_URL = process.env.DIRECTUS_URL;
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN;

if (!DIRECTUS_URL || !DIRECTUS_TOKEN) {
  console.error('DIRECTUS_URL of DIRECTUS_TOKEN ontbreekt in .env');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${DIRECTUS_TOKEN}`,
};

const COLLECTIE = 'Belgeschiedenis';

const velden = [
  { field: 'bedrijf', type: 'integer', meta: { interface: 'input', note: 'Welk bedrijf belde', width: 'half' } },
  {
    field: 'richting', type: 'string',
    meta: {
      interface: 'select-dropdown', width: 'half',
      options: { choices: [{ text: 'Uitgaand', value: 'uitgaand' }, { text: 'Inkomend', value: 'inkomend' }] },
    },
  },
  {
    field: 'soort', type: 'string',
    meta: {
      interface: 'select-dropdown', width: 'half',
      options: {
        choices: [
          { text: 'Personeel', value: 'personeel' }, { text: 'Terugbellen', value: 'terugbel' },
          { text: 'Lead', value: 'lead' }, { text: 'Briefing', value: 'briefing' },
          { text: 'Los script', value: 'los' },
        ],
      },
    },
  },
  { field: 'opdracht_id', type: 'integer', meta: { interface: 'input', note: 'Belopdracht waar dit gesprek bij hoort', width: 'half' } },
  { field: 'naam', type: 'string', meta: { interface: 'input', width: 'half' } },
  { field: 'nummer', type: 'string', meta: { interface: 'input', width: 'half' } },
  { field: 'kanaal', type: 'string', meta: { interface: 'input', note: 'Kanaal-id in Asterisk', width: 'half', hidden: true } },
  { field: 'uitgebeld', type: 'timestamp', meta: { interface: 'datetime', width: 'half' } },
  { field: 'opgenomen', type: 'timestamp', meta: { interface: 'datetime', note: 'Leeg als er niet is opgenomen', width: 'half' } },
  { field: 'beeindigd', type: 'timestamp', meta: { interface: 'datetime', width: 'half' } },
  { field: 'rinkelde_seconden', type: 'float', meta: { interface: 'input', width: 'half' } },
  { field: 'duur_seconden', type: 'float', meta: { interface: 'input', note: 'Gespreksduur vanaf opnemen', width: 'half' } },
  { field: 'toets', type: 'string', meta: { interface: 'input', note: 'Welke toets de ontvanger indrukte', width: 'half' } },
  { field: 'reden', type: 'string', meta: { interface: 'input', note: 'Waarom de oproep eindigde', width: 'half' } },
  { field: 'script', type: 'text', meta: { interface: 'input-multiline', note: 'Wat de bot heeft voorgelezen' } },
];

async function bestaat(): Promise<boolean> {
  const res = await fetch(`${DIRECTUS_URL}/collections/${COLLECTIE}`, { headers });
  return res.ok;
}

async function maakCollectie(): Promise<void> {
  const res = await fetch(`${DIRECTUS_URL}/collections`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      collection: COLLECTIE,
      meta: {
        icon: 'phone_in_talk',
        note: 'Wat er van elke uitgaande oproep terechtkwam',
        display_template: '{{nummer}} — {{duur_seconden}}s',
        sort_field: null,
      },
      schema: { name: COLLECTIE },
      fields: [
        {
          field: 'id', type: 'integer',
          meta: { hidden: true, interface: 'numeric', readonly: true },
          schema: { is_primary_key: true, has_auto_increment: true },
        },
        ...velden,
      ],
    }),
  });
  if (!res.ok) throw new Error(`Collectie aanmaken mislukt: ${res.status} ${await res.text()}`);
  console.log(`Collectie ${COLLECTIE} aangemaakt met ${velden.length + 1} velden.`);
}

async function vulAanOntbrekendeVelden(): Promise<void> {
  const res = await fetch(`${DIRECTUS_URL}/fields/${COLLECTIE}`, { headers });
  const aanwezig = new Set(((await res.json()).data as Array<{ field: string }>).map((f) => f.field));
  for (const veld of velden) {
    if (aanwezig.has(veld.field)) continue;
    const r = await fetch(`${DIRECTUS_URL}/fields/${COLLECTIE}`, {
      method: 'POST', headers, body: JSON.stringify(veld),
    });
    console.log(r.ok ? `Veld ${veld.field} toegevoegd.` : `Veld ${veld.field} mislukt: ${await r.text()}`);
  }
}

async function main(): Promise<void> {
  if (await bestaat()) {
    console.log(`Collectie ${COLLECTIE} bestaat al; alleen ontbrekende velden aanvullen.`);
    await vulAanOntbrekendeVelden();
  } else {
    await maakCollectie();
  }
  console.log('Klaar.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
