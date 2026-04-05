/**
 * Seed script: creates the 3 bedrijven in Directus.
 *
 * Usage:  npx tsx scripts/seed-bedrijven.ts
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

// First, check which fields exist on Bedrijven
async function checkSchema() {
  const res = await fetch(`${DIRECTUS_URL}/fields/Bedrijven`, { headers });
  if (!res.ok) {
    console.error(`Failed to fetch schema: ${res.status} ${res.statusText}`);
    const body = await res.text();
    console.error(body);
    process.exit(1);
  }
  const data = await res.json();
  const fields = data.data.map((f: { field: string }) => f.field);
  console.log('Bedrijven fields:', fields);
  return fields;
}

const bedrijven = [
  {
    status: 'published',
    title: 'IP Voice Group',
    description: 'IP Voice Group is een toonaangevende leverancier van zakelijke telecomoplossingen, VoIP-diensten en unified communications voor het MKB en enterprise.',
    branche: 'Telecommunicatie / IT',
    website: 'https://ipvoicegroup.nl',
    brand_colors: { primary: '#1a1a2e', secondary: '#0f3460', text: '#ffffff' },
    tone_of_voice: 'Professioneel, betrouwbaar, innovatief en toegankelijk. Technische expertise vertaald naar begrijpelijke taal.',
    target_audience: 'MKB-ondernemers, IT-managers en facilitair managers die op zoek zijn naar betrouwbare en schaalbare telecomoplossingen.',
    unique_selling_points: [
      'Persoonlijke service en korte lijnen',
      'Schaalbare VoIP-oplossingen voor elk bedrijf',
      'Expertise in unified communications',
      'Nederlandse support en hosting',
    ],
    content_pillars: ['Telecom innovatie', 'Klantcases', 'Tips voor zakelijke communicatie', 'Productnieuws'],
    posting_goals: {
      instagram: { per_week: 3, type: ['educational', 'behind_the_scenes', 'promotional'] },
      facebook: { per_week: 3, type: ['educational', 'engagement', 'promotional'] },
      linkedin: { per_week: 4, type: ['educational', 'promotional', 'testimonial'] },
    },
  },
  {
    status: 'published',
    title: 'IP Voice Shop',
    description: 'IP Voice Shop is de webshop voor zakelijke telefoons, headsets, conferentiesystemen en VoIP-apparatuur tegen scherpe prijzen.',
    branche: 'E-commerce / Telecom hardware',
    website: 'https://ipvoiceshop.nl',
    brand_colors: { primary: '#2d3436', secondary: '#00b894', text: '#ffffff' },
    tone_of_voice: 'Vriendelijk, helder en productgericht. Focus op voordelen en gebruiksgemak.',
    target_audience: 'Office managers, inkopers en IT-beheerders die zakelijke communicatieapparatuur zoeken.',
    unique_selling_points: [
      'Scherpe prijzen op topmerken',
      'Snelle levering door heel Nederland',
      'Deskundig advies bij productkeuze',
      'Ruim assortiment VoIP-hardware',
    ],
    content_pillars: ['Productreviews', 'Aanbiedingen', 'Kooptips', 'Werkplek-inspiratie'],
    posting_goals: {
      instagram: { per_week: 3, type: ['promotional', 'educational', 'engagement'] },
      facebook: { per_week: 3, type: ['promotional', 'engagement', 'testimonial'] },
      linkedin: { per_week: 2, type: ['promotional', 'educational'] },
    },
  },
  {
    status: 'published',
    title: 'IJs uit de Polder',
    description: 'IJs uit de Polder maakt ambachtelijk roomijs met verse, lokale ingredienten uit de Hollandse polder. Eerlijk, puur en onweerstaanbaar lekker.',
    branche: 'Food & Beverage / Horeca',
    website: 'https://ijsuitdepolder.nl',
    brand_colors: { primary: '#ff6b6b', secondary: '#feca57', text: '#2d3436' },
    tone_of_voice: 'Warm, speels, authentiek en uitnodigend. Dichtbij de consument, met liefde voor het vak.',
    target_audience: 'IJsliefhebbers, gezinnen, foodies en horecaondernemers op zoek naar ambachtelijk ijs.',
    unique_selling_points: [
      'Ambachtelijk bereid met lokale ingredienten',
      'Verse smaken per seizoen',
      'Geen kunstmatige toevoegingen',
      'Echt Hollands polder-ijs',
    ],
    content_pillars: ['Smaken & seizoenen', 'Behind the scenes', 'Polder verhalen', 'Klantmomenten'],
    posting_goals: {
      instagram: { per_week: 5, type: ['behind_the_scenes', 'promotional', 'engagement', 'educational'] },
      facebook: { per_week: 3, type: ['promotional', 'engagement', 'behind_the_scenes'] },
      tiktok: { per_week: 3, type: ['behind_the_scenes', 'engagement', 'promotional'] },
    },
  },
];

async function seedBedrijven(existingFields: string[]) {
  for (const bedrijf of bedrijven) {
    // Only send fields that exist in the collection
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(bedrijf)) {
      if (existingFields.includes(key)) {
        payload[key] = value;
      }
    }

    console.log(`\nCreating: ${bedrijf.title}...`);

    const res = await fetch(`${DIRECTUS_URL}/items/Bedrijven`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`  Created with ID: ${data.data.id}`);
    } else {
      const error = await res.text();
      console.error(`  Failed: ${res.status} ${error}`);
    }
  }
}

async function main() {
  console.log(`Directus: ${DIRECTUS_URL}`);
  console.log('Checking Bedrijven schema...\n');

  const fields = await checkSchema();
  await seedBedrijven(fields);

  console.log('\nDone!');
}

main().catch(console.error);
