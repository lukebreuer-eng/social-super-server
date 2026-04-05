/**
 * Seed script: creates competitor records in Directus for IP Voice Shop.
 *
 * Usage:  npx tsx scripts/seed-competitors-shop.ts
 *
 * Reads DIRECTUS_URL and DIRECTUS_TOKEN from .env
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
  'Authorization': `Bearer ${DIRECTUS_TOKEN}`,
};

async function getBedrijfId(): Promise<number> {
  const res = await fetch(`${DIRECTUS_URL}/items/Bedrijven?filter[title][_contains]=IP Voice Shop&limit=1`, { headers });
  const data = await res.json();
  if (!data.data?.length) {
    console.error('IP Voice Shop not found in Bedrijven');
    process.exit(1);
  }
  return data.data[0].id;
}

const competitors = [
  {
    naam: 'DectDirect',
    platform: 'all',
    profile_url: 'https://www.dectdirect.nl/',
    notes: `Telecom & IT webshop. Reviews: 9.2/10 (1.440 reviews Kiyoh). Chat support. Gratis verzending Benelux. Breed: headsets, telefonie, networking, security, printers, computers. Merken: Jabra, TP-Link, Ubiquiti.

Sterkte: Hoogste reviews in de markt, breed assortiment, live chat
Zwakte: Pure retail, geen advies-naar-diensten funnel
Concurreert op: Dezelfde producten, zelfde zoekwoorden in Google`,
  },
  {
    naam: 'Azerty Zakelijk',
    platform: 'all',
    profile_url: 'https://azerty.nl/zakelijk',
    notes: `Grootste computer webshop NL. Zakelijke divisie met telecom, headsets, VoIP. Next-day delivery (voor 23:00 besteld). Aparte zakelijke webshop: azertyzakelijk.nl.

Sterkte: Naamsbekendheid, logistiek, prijs, enorm assortiment
Zwakte: Generalist, geen telecom expertise, geen persoonlijk advies
Realiteit: Onmogelijk op prijs te concurreren — focus op specialist-USP`,
  },
  {
    naam: 'Headsets.nl',
    platform: 'all',
    profile_url: 'https://www.headsets.nl/',
    notes: `Specialist headsets, 30 jaar ervaring. "Een van de grootste headset leveranciers in Europa." Merken: Poly, Jabra, EPOS/Sennheiser, Yealink, United Headsets. Teams-certificering prominent.

Sterkte: Pure specialist, 30 jaar, prijzen zichtbaar, voorraadstatus, vergelijkingstool
Zwakte: Geen reviews op homepage, geen chat, alleen headsets
Concurreert op: Headset zoekwoorden, specialist-positionering`,
  },
  {
    naam: 'Onedirect',
    platform: 'all',
    profile_url: 'https://www.onedirect.nl/',
    notes: `"Europa's #1 leverancier telefoons, headsets, audioconference." Minimum order €300 excl BTW (B2B). 14 dagen gratis uitproberen. Gratis levering NL.

Sterkte: Europees merk, B2B focus, trial-optie
Zwakte: Hoge minimum order, minder NL-gericht, afstandelijker
Concurreert op: B2B headsets en conferentie-apparatuur`,
  },
  {
    naam: 'TelecomShop.nl',
    platform: 'all',
    profile_url: 'https://www.telecomshop.nl/',
    notes: `B2B telecom specialist, 20+ jaar. Reviews: 8.9/10 (1.023 reviews Kiyoh). Live chat (Tawk.to). Gratis verzending >€100. Merken: Jabra, Yealink, Plantronics, Logitech, Samsung, Cisco, Polycom, Grandstream, Gigaset.

Sterkte: Gevestigd, goede reviews, live chat, breed B2B telecom assortiment
Zwakte: Geen link naar diensten/advies
Meest vergelijkbaar met IP Voice Shop qua positionering`,
  },
];

async function seedCompetitors(bedrijfId: number) {
  const existingRes = await fetch(`${DIRECTUS_URL}/items/Competitors?filter[bedrijf][_eq]=${bedrijfId}`, { headers });
  const existingData = await existingRes.json();
  const existingNames = (existingData.data || []).map((c: { naam: string }) => c.naam.toLowerCase());

  for (const competitor of competitors) {
    if (existingNames.includes(competitor.naam.toLowerCase())) {
      console.log(`  ${competitor.naam} — already exists, updating...`);
      const existing = existingData.data.find((c: { naam: string }) => c.naam.toLowerCase() === competitor.naam.toLowerCase());
      if (existing) {
        const updateRes = await fetch(`${DIRECTUS_URL}/items/Competitors/${existing.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ ...competitor, bedrijf: bedrijfId }),
        });
        console.log(`  ${competitor.naam} — ${updateRes.ok ? 'updated' : 'update failed: ' + updateRes.status}`);
      }
    } else {
      console.log(`  ${competitor.naam} — creating...`);
      const res = await fetch(`${DIRECTUS_URL}/items/Competitors`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...competitor, bedrijf: bedrijfId }),
      });
      if (res.ok) {
        const data = await res.json();
        console.log(`  ${competitor.naam} — created (ID: ${data.data.id})`);
      } else {
        const error = await res.text();
        console.error(`  ${competitor.naam} — failed: ${res.status} ${error}`);
      }
    }
  }
}

async function main() {
  console.log(`Directus: ${DIRECTUS_URL}\n`);
  const bedrijfId = await getBedrijfId();
  console.log(`IP Voice Shop ID: ${bedrijfId}\n`);
  console.log('Seeding competitors...\n');
  await seedCompetitors(bedrijfId);
  console.log('\nDone!');
}

main().catch(console.error);
