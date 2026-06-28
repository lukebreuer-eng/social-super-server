/**
 * Seed script: Google Search Console koppeling.
 *
 *  - Maakt de collectie GSC_Keywords aan (snapshot van zoekqueries per bedrijf).
 *  - Voegt het veld gsc_site_url toe aan Bedrijven (welke GSC-property hoort
 *    bij welk bedrijf).
 *  - Zet de bekende site-URLs alvast goed.
 *
 * Usage:  npx tsx scripts/seed-gsc.ts
 * Leest DIRECTUS_URL en DIRECTUS_TOKEN uit .env
 */

import dotenv from 'dotenv';
dotenv.config();

const DIRECTUS_URL = process.env.DIRECTUS_URL;
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN;

if (!DIRECTUS_URL || !DIRECTUS_TOKEN) {
  console.error('Missing DIRECTUS_URL or DIRECTUS_TOKEN in .env');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${DIRECTUS_TOKEN}`,
};

async function collectionExists(name: string): Promise<boolean> {
  const res = await fetch(`${DIRECTUS_URL}/collections/${name}`, { headers });
  return res.ok;
}

async function createGscCollection() {
  if (await collectionExists('GSC_Keywords')) {
    console.log('  Collectie GSC_Keywords bestaat al, skip');
    return;
  }
  const body = {
    collection: 'GSC_Keywords',
    meta: { icon: 'search', note: 'Snapshot van Google Search Console zoekqueries per bedrijf' },
    schema: {},
    fields: [
      { field: 'id', type: 'integer', meta: { hidden: true }, schema: { is_primary_key: true, has_auto_increment: true } },
      { field: 'bedrijf', type: 'integer', meta: { interface: 'input', width: 'half' }, schema: { is_nullable: false } },
      { field: 'query', type: 'string', meta: { interface: 'input' }, schema: { is_nullable: false, max_length: 500 } },
      { field: 'clicks', type: 'integer', meta: { interface: 'input', width: 'half' }, schema: { default_value: 0 } },
      { field: 'impressies', type: 'integer', meta: { interface: 'input', width: 'half' }, schema: { default_value: 0 } },
      { field: 'ctr', type: 'float', meta: { interface: 'input', width: 'half', note: '%' }, schema: { default_value: 0 } },
      { field: 'positie', type: 'float', meta: { interface: 'input', width: 'half' }, schema: { default_value: 0 } },
      { field: 'periode_dagen', type: 'integer', meta: { interface: 'input', width: 'half' }, schema: { default_value: 90 } },
      { field: 'date_synced', type: 'date', meta: { interface: 'datetime', width: 'half' }, schema: {} },
    ],
  };
  const res = await fetch(`${DIRECTUS_URL}/collections`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (res.ok) console.log('  Collectie GSC_Keywords aangemaakt');
  else console.error(`  Fout bij aanmaken GSC_Keywords: ${res.status} ${await res.text()}`);
}

async function addFieldIfNotExists(collection: string, fieldDef: Record<string, unknown>) {
  const fieldName = fieldDef.field as string;
  const check = await fetch(`${DIRECTUS_URL}/fields/${collection}/${fieldName}`, { headers });
  if (check.ok) {
    console.log(`  Veld ${collection}.${fieldName} bestaat al, skip`);
    return;
  }
  const res = await fetch(`${DIRECTUS_URL}/fields/${collection}`, { method: 'POST', headers, body: JSON.stringify(fieldDef) });
  if (res.ok) console.log(`  Veld ${collection}.${fieldName} aangemaakt`);
  else console.error(`  Fout bij ${collection}.${fieldName}: ${res.status} ${await res.text()}`);
}

async function setGscSiteUrl(bedrijfId: number, siteUrl: string) {
  const res = await fetch(`${DIRECTUS_URL}/items/Bedrijven/${bedrijfId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ gsc_site_url: siteUrl }),
  });
  if (res.ok) console.log(`  Bedrijf ${bedrijfId} gsc_site_url = ${siteUrl}`);
  else console.error(`  Fout bij bedrijf ${bedrijfId}: ${res.status} ${await res.text()}`);
}

async function main() {
  console.log(`Directus: ${DIRECTUS_URL}\n`);

  console.log('1. GSC_Keywords collectie...');
  await createGscCollection();

  console.log('\n2. gsc_site_url veld op Bedrijven...');
  await addFieldIfNotExists('Bedrijven', {
    field: 'gsc_site_url',
    type: 'string',
    meta: {
      interface: 'input',
      note: 'GSC property: https://domein.nl/ (URL-prefix) of sc-domain:domein.nl (domain property)',
      width: 'half',
    },
    schema: { is_nullable: true, max_length: 255 },
  });

  console.log('\n3. Site-URLs zetten (IJs is geverifieerd als URL-prefix property)...');
  await setGscSiteUrl(7, 'https://ijsuitdepolder.nl/'); // IJs uit de Polder
  // IPVG (5) en Shop (6): pas aan als jouw GSC-property een domain-property is.
  await setGscSiteUrl(5, 'https://ipvoicegroup.nl/');
  await setGscSiteUrl(6, 'https://ipvoiceshop.nl/');

  console.log('\n--- KLAAR ---');
  console.log('Vergeet niet: zet GSC_SERVICE_ACCOUNT_JSON in de server-env en voeg het');
  console.log('service-account e-mailadres als gebruiker toe aan elke GSC-property.');
}

main().catch(console.error);
