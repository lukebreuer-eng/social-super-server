/**
 * Seed script: creates competitor records in Directus for IJs uit de Polder.
 * Based on Luke's market knowledge — real competitors he encounters in practice.
 *
 * Usage:  npx tsx scripts/seed-competitors-ijs.ts
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
  const res = await fetch(`${DIRECTUS_URL}/items/Bedrijven?filter[title][_contains]=IJs uit de Polder&limit=1`, { headers });
  const data = await res.json();
  if (!data.data?.length) {
    console.error('IJs uit de Polder not found in Bedrijven');
    process.exit(1);
  }
  return data.data[0].id;
}

const competitors = [
  {
    naam: 'Gebo Gelato',
    platform: 'all',
    profile_url: 'https://www.facebook.com/ijssalongebogelatozeewolde/',
    notes: `DIRECTE LOKALE CONCURRENT — enige ijssalon in Zeewolde. Horsterplein 40, 200m van strand. Familiebedrijf sinds 1950. Italiaans ijs, Lavazza koffie, wafels, shakes. Fabrieksijs uit Vlissingen, ijstaarten ook uit fabriek.

Website: ijssalonzeewolde.nl / gebogelatozeewolde.nl
Social: Facebook + Instagram actief
Doel: Inhalen op Facebook volgers — zijn al aardig op weg
Sterkte: Fysieke locatie in Zeewolde, naamsbekendheid lokaal, sinds 1950
Zwakte: Fabrieksijs (niet ambachtelijk eigen productie), geen mobiele catering
Concurrent op: Lokale markt Zeewolde, naamsbekendheid, social media volgers`,
  },
  {
    naam: 'Kok Cateringservice',
    platform: 'all',
    profile_url: 'https://kokcateringservice.nl/ijswagen/',
    notes: `Amersfoort. Heeft een ROZE Bedford ijswagen — directe concurrent op Bedford segment. Plus nostalgische handijskar. Breed catering portfolio (foodtrucks, BBQ, streetfood). Heel NL.

Website: kokcateringservice.nl — matig conversie, geen reviews zichtbaar
Prijs: Reiskosten €0,70/km (<80km) en €0,90/km (>80km)
Contact: 033-7370015, Catermonkey booking systeem
Sterkte: Bedford wagen (direct vergelijkbaar), breed catering aanbod, Amersfoort = dichtbij
Zwakte: Ijs is onderdeel van breder cateringaanbod, niet gespecialiseerd
Concurrent op: Bedford ijswagen verhuur, regio midden-NL`,
  },
  {
    naam: 'De Foodtruck Club / Gelato Amici',
    platform: 'all',
    profile_url: 'https://defoodtruckclub.nl/foodtrucks/ijs-foodtruck',
    notes: `Landelijk. 8 foodtruck concepten, 11 trucks totaal. Gelato Amici is hun ijs-concept: handgemaakt Italiaans gelato, 100% biologische melk van lokale boerderij. Grote corporate klanten: Booking.com, TUI, F1, Red Bull, Tommy Hilfiger, Feyenoord.

Website: defoodtruckclub.nl — offerte binnen 1 werkdag
Sterkte: Grote merken als klant, biologisch, professionele uitstraling
Zwakte: Ijs is 1 van 8 concepten, niet gespecialiseerd
Concurrent op: Bedrijfsevenementen, grote corporate events`,
  },
  {
    naam: 'Lekker Gemekker',
    platform: 'all',
    profile_url: 'https://www.lekkergemekker.nl/ijskar-huren',
    notes: `Andel (Noord-Brabant). Eigen geitenboerderij — geitenijs als USP. Farm-to-table concept. 4 voertuigen: duwwagen, 2 foodtrucks, IJskar Jetje. Levert ook in Gelderland en Utrecht.

Website: lekkergemekker.nl — offerte aanvragen via formulier
Sterkte: Uniek product (geitenijs), eigen boerderij verhaal, authentiek
Zwakte: Niche product (niet iedereen houdt van geitenijs), kleiner bereik
Concurrent op: Ambachtelijk/lokaal verhaal, events in Gelderland`,
  },
  {
    naam: 'IJssalon IJstijd',
    platform: 'all',
    profile_url: 'https://ijssalonijstijd.nl/',
    notes: `Veluwe — 3 salons in Garderen, Voorthuizen en Ermelo. EIGEN PRODUCTIEKEUKEN in Uddel. 50+ smaken. Sinds 2003. Bieden ook ijskar op locatie aan voor bruiloften en bedrijfsevents. Social: Instagram + Facebook + TikTok.

Website: ijssalonijstijd.nl
Sterkte: Eigen productiekeuken (net als wij!), 3 fysieke locaties op de Veluwe, 50+ smaken, TikTok aanwezig
Zwakte: Focus op salons, ijskar verhuur is bijzaak
Concurrent op: Eigen productie verhaal, Veluwe regio (onze achtertuin), events met ijskar`,
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
  console.log(`IJs uit de Polder ID: ${bedrijfId}\n`);
  console.log('Seeding competitors...\n');
  await seedCompetitors(bedrijfId);
  console.log('\nDone!');
}

main().catch(console.error);
