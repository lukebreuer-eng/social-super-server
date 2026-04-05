/**
 * Seed script: creates competitor records in Directus for IP Voice Group.
 *
 * Usage:  npx tsx scripts/seed-competitors.ts
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

// Get bedrijf ID for IP Voice Group
async function getBedrijfId(): Promise<number> {
  const res = await fetch(`${DIRECTUS_URL}/items/Bedrijven?filter[title][_contains]=IP Voice Group&limit=1`, { headers });
  const data = await res.json();
  if (!data.data?.length) {
    console.error('IP Voice Group not found in Bedrijven');
    process.exit(1);
  }
  return data.data[0].id;
}

const competitors = [
  {
    naam: 'Esprit ICT',
    platform: 'all',
    profile_url: 'https://www.linkedin.com/company/esprit-ict',
    notes: `Grootste Mitel partner NL. Fusie van Detron + Zetacom + Yourizon + BproCare. Eigendom Avedon Capital. 600+ medewerkers. Platinum Mitel Partner. Enige gecertificeerde Healthcare Solution Expert. Actief op zorg-events (Zorg & ICT). Partner/concurrent — IP Voice Group host Mitel klanten voor ze.

Website: esprit-ict.nl
LinkedIn: 9.470 volgers, 2-3x/week posts
Conversie: 7/10 — adviesgesprek CTA, newsletter, case studies
Segment: Enterprise, Zorg, Mitel hosted
Sterkte: Schaalgrootte, zorg-expertise, LinkedIn dominantie
Zwakte: PE-groep = minder persoonlijk`,
  },
  {
    naam: 'Voys',
    platform: 'all',
    profile_url: 'https://www.linkedin.com/company/voys-telecom/',
    notes: `Grootste cloud telefonie provider NL. 19.000+ klanten. 20+ jaar ervaring. Twee divisies: MKB (Voys) en Grootzakelijk (voorheen Mitel private cloud, nu Intermedia Unite whitelabel). Directe concurrent op Intermedia — zij Unite, wij Elevate.

Website: voys.nl / voys.co
LinkedIn: groot bereik
Conversie: 8.5/10 — BESTE in de markt. 4.300+ reviews (8.7 gem), "per dag opzegbaar", snelle onboarding, sterke social proof
Segment: MKB cloud telefonie + Grootzakelijk UCaaS
Sterkte: Reviews, conversie, merkbekendheid, transparantie
Zwakte: Geen IT/security/AV (puur telefonie)
Leer van: Hun social proof strategie en conversie-optimalisatie`,
  },
  {
    naam: 'Hallo',
    platform: 'all',
    profile_url: 'https://www.linkedin.com/company/hallo-ict',
    notes: `MKB ICT-dienstverlener. 500-1000 medewerkers. Vestiging in ZEEWOLDE (buurman!). Opgericht 2006. Breed portfolio: werkplekken, telefonie, internet, security, cloud.

Website: hallo.eu
LinkedIn: 500+ volgers
Conversie: 7/10 — whitepapers, webinars, newsletter, prominente telefoon
Segment: MKB managed IT + telecom (zelfde "alles onder een dak" model)
Sterkte: Grootte, content marketing (whitepapers/webinars), lokale aanwezigheid
Zwakte: Geen enterprise/callcenter expertise`,
  },
  {
    naam: 'TSV Groep',
    platform: 'all',
    profile_url: 'https://www.linkedin.com/company/tsvgroep',
    notes: `Onafhankelijke telecom integrator sinds 1993. 50 medewerkers. Amsterdam. Mitel + Avaya + NEC partner. ISO 27001 gecertificeerd. Complexe callcenter implementaties.

Website: tsv-groep.nl
LinkedIn: 687 volgers, ~1x/maand posts
Conversie: 7.5/10 — HubSpot formulieren, meerdere CTA's, testimonials, blog
Segment: Enterprise telecom, callcenters, hospitality
Sterkte: Onafhankelijk (net als wij), goede website, multi-vendor
Zwakte: Klein, beperkte online zichtbaarheid`,
  },
  {
    naam: 'Voicecon',
    platform: 'all',
    profile_url: 'https://voicecon.nl/',
    notes: `Mitel specialist en Mitel Customer Champion. 20+ jaar ervaring. Training, beheer en installatie. Pakt klanten op uit consolidatierondes (Detron/Zetacom fusie etc).

Website: voicecon.nl
LinkedIn: minimaal (geen actieve bedrijfspagina NL)
Conversie: 6.5/10 — 24/7 support, lage drempel contact, geen lead magnets
Segment: Mitel beheer en migratie
Sterkte: Diepe Mitel technische kennis, persoonlijk, pikt klanten op uit overnames
Zwakte: Niet actief online, geen content marketing`,
  },
  {
    naam: 'Techone',
    platform: 'all',
    profile_url: 'https://www.linkedin.com/company/techonenl',
    notes: `Groep met 50+ overnames in IT en Telecom. Bezit o.a. Lagarde Groep, Nemesys, Hupra/NuCall, YourTelecom, Fit4Telecom, IC-Automatisering. Recent uitgebreid naar Flevoland (overname Dare IT).

Website: techone.nl
LinkedIn: 2.850 volgers, 1-2x/week posts (overnames, partnerships)
Segment: MKB IT + Telecom (breed, via lokale merken)
Sterkte: Schaalgrootte via overnames, landelijke dekking
Zwakte: Gefragmenteerd (50+ merken), PE-groep = minder persoonlijk`,
  },
  {
    naam: 'Lagarde Groep',
    platform: 'all',
    profile_url: 'https://nl.linkedin.com/company/lagarde_2',
    notes: `Onderdeel van Techone. Mitel Gold Partner. Sinds 1991. ICT + telecom + security. Heeft mitelvoip.nl. Nieuwe directeur Dick Bloemert (jan 2026). Viert 35 jaar in juli 2026.

Website: lagarde.nl / mitelvoip.nl
LinkedIn: ~200 volgers, lage activiteit
Segment: MKB Mitel, breed IT portfolio
Sterkte: 30+ jaar ervaring, Mitel Gold, eigen klantenbasis
Zwakte: Nu onder Techone — onduidelijk hoeveel autonomie
Apart tracken: eigen merk, eigen klanten, directe Mitel concurrent`,
  },
  {
    naam: 'Nemesys ICT Groep',
    platform: 'all',
    profile_url: 'https://nl.linkedin.com/company/nemesysictgroep',
    notes: `Onderdeel van Techone (1 van 30+ bedrijven). 30 jaar ervaring. Regio Zuid-Holland (Oud-Beijerland). IT + telefonie + cybersecurity. Contact center oplossingen.

Website: nemesys.nl
LinkedIn: 1.459 volgers
Segment: MKB IT + telecom + security, regio Zuid-Holland
Sterkte: Breed portfolio (lijkt op ons), security focus, lokale klantenbasis
Zwakte: Regionaal, onderdeel PE-groep
Apart tracken: actief op LinkedIn, eigen klanten, vergelijkbaar profiel`,
  },
];

async function seedCompetitors(bedrijfId: number) {
  // First check existing competitors
  const existingRes = await fetch(`${DIRECTUS_URL}/items/Competitors?filter[bedrijf][_eq]=${bedrijfId}`, { headers });
  const existingData = await existingRes.json();
  const existingNames = (existingData.data || []).map((c: { naam: string }) => c.naam.toLowerCase());

  for (const competitor of competitors) {
    if (existingNames.includes(competitor.naam.toLowerCase())) {
      console.log(`  ${competitor.naam} — already exists, updating...`);
      // Find ID and update
      const existing = existingData.data.find((c: { naam: string }) => c.naam.toLowerCase() === competitor.naam.toLowerCase());
      if (existing) {
        const updateRes = await fetch(`${DIRECTUS_URL}/items/Competitors/${existing.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ ...competitor, bedrijf: bedrijfId }),
        });
        if (updateRes.ok) {
          console.log(`  ${competitor.naam} — updated`);
        } else {
          console.error(`  ${competitor.naam} — update failed: ${updateRes.status}`);
        }
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
  console.log(`IP Voice Group ID: ${bedrijfId}\n`);
  console.log('Seeding competitors...\n');
  await seedCompetitors(bedrijfId);
  console.log('\nDone!');
}

main().catch(console.error);
