/**
 * Seed script: creates AI suggestions in Directus for all 3 bedrijven.
 * Based on competitor analysis, cold lead plan, and market knowledge.
 *
 * Usage:  npx tsx scripts/seed-ai-suggestions.ts
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

async function getBedrijfId(name: string): Promise<number> {
  const res = await fetch(`${DIRECTUS_URL}/items/Bedrijven?filter[title][_contains]=${encodeURIComponent(name)}&limit=1`, { headers });
  const data = await res.json();
  if (!data.data?.length) {
    console.error(`${name} not found in Bedrijven`);
    return 0;
  }
  return data.data[0].id;
}

interface Suggestion {
  bedrijf: number;
  suggestion_type: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  action_taken: boolean;
  confidence: number;
  data_basis: Record<string, unknown>;
}

function buildSuggestions(ipvgId: number, ijsId: number, shopId: number): Suggestion[] {
  return [
    // ===== IP VOICE GROUP =====
    {
      bedrijf: ipvgId,
      suggestion_type: 'content_idea',
      title: 'Blog reactiveren: "5 signalen dat je telefonie verouderd is"',
      description: 'Laatste blog was april 2024. Dit is het #1 probleem-zoekwoord voor jullie doelgroep. IT managers herkennen dit en klikken door. Publiceer via de blog module op ipvoicegroup.com.',
      priority: 'urgent',
      status: 'new',
      action_taken: false,
      confidence: 0.92,
      data_basis: { bron: 'cold_lead_plan', keyword: 'telefonie verouderd', type: 'blog' },
    },
    {
      bedrijf: ipvgId,
      suggestion_type: 'content_idea',
      title: 'Blog: "Overstappen naar cloud telefonie: het complete stappenplan"',
      description: 'Hoog koopintentie zoekwoord. Mensen die dit googelen overwegen actief een switch. Lead magnet "Gratis Telecom Scan" onderaan plaatsen.',
      priority: 'high',
      status: 'new',
      action_taken: false,
      confidence: 0.90,
      data_basis: { bron: 'cold_lead_plan', keyword: 'overstappen cloud telefonie', type: 'blog' },
    },
    {
      bedrijf: ipvgId,
      suggestion_type: 'content_idea',
      title: 'Blog: "3CX vs Microsoft Teams: eerlijke vergelijking"',
      description: 'Vergelijkings-zoekwoord met hoge intentie. Jullie leveren beide — positioneer als onafhankelijk adviseur die helpt kiezen.',
      priority: 'high',
      status: 'new',
      action_taken: false,
      confidence: 0.88,
      data_basis: { bron: 'cold_lead_plan', keyword: '3CX vs Teams', type: 'blog' },
    },
    {
      bedrijf: ipvgId,
      suggestion_type: 'content_idea',
      title: 'LinkedIn persoonlijk: Luke als thought leader',
      description: 'Beslissers volgen mensen, geen bedrijven. Luke 2-3x/week korte posts: klantervaringen, meningen, tips. Social server schrijft, Luke plaatst met persoonlijke noot. Voorbeeld: "Gisteren bij een zorginstelling. 200 medewerkers, telefonie van 2015..."',
      priority: 'urgent',
      status: 'new',
      action_taken: false,
      confidence: 0.85,
      data_basis: { bron: 'cold_lead_plan', platform: 'linkedin', type: 'personal_brand' },
    },
    {
      bedrijf: ipvgId,
      suggestion_type: 'performance_alert',
      title: 'Lead magnet bouwen: "Gratis Telecom Scan"',
      description: 'Geen enkele concurrent biedt dit. Landing page op ipvoicegroup.com met formulier (naam, email, bedrijf, aantal medewerkers). Promoten via blogs en LinkedIn. Luke belt binnen 24u.',
      priority: 'high',
      status: 'new',
      action_taken: false,
      confidence: 0.87,
      data_basis: { bron: 'cold_lead_plan', type: 'lead_magnet' },
    },
    {
      bedrijf: ipvgId,
      suggestion_type: 'performance_alert',
      title: 'Google reviews verzamelen — nu 0 zichtbaar',
      description: 'Voys heeft 4.300 reviews. Jullie 0 zichtbaar online. Vraag 10 tevreden klanten om een Google review. Dit is de snelste manier om vertrouwen op te bouwen.',
      priority: 'urgent',
      status: 'new',
      action_taken: false,
      confidence: 0.95,
      data_basis: { bron: 'competitor_analysis', concurrent: 'Voys', metric: 'reviews' },
    },
    {
      bedrijf: ipvgId,
      suggestion_type: 'competitor_move',
      title: 'Esprit ICT domineert LinkedIn (9.470 volgers)',
      description: 'Esprit ICT post 2-3x/week over zorg, events, AI. Jullie zitten op 234 volgers. Focus op niche-content die zij niet maken: persoonlijke klantverhalen, MKB-gerichte tips, Intermedia Elevate content.',
      priority: 'medium',
      status: 'new',
      action_taken: false,
      confidence: 0.82,
      data_basis: { bron: 'competitor_analysis', concurrent: 'Esprit ICT', metric: 'linkedin_followers' },
    },
    {
      bedrijf: ipvgId,
      suggestion_type: 'competitor_move',
      title: 'Voys nu ook Intermedia concurrent',
      description: 'Voys grootzakelijk draait op Intermedia Unite (whitelabel). Jullie starten met Intermedia Elevate. Positioneer het verschil: Elevate = nieuwer, meer features. Blog schrijven: "Intermedia Elevate vs Unite: wat is het verschil?"',
      priority: 'medium',
      status: 'new',
      action_taken: false,
      confidence: 0.80,
      data_basis: { bron: 'competitor_analysis', concurrent: 'Voys', product: 'Intermedia' },
    },
    {
      bedrijf: ipvgId,
      suggestion_type: 'audience_insight',
      title: 'USP benadrukken: "Onafhankelijk, geen PE-groep"',
      description: 'Esprit ICT = Avedon Capital, Techone = 50+ overnames, Yielder = Capital A. Jullie zijn onafhankelijk met persoonlijke service. Klanten kiezen jullie omdat ze geen nummer willen zijn. Maak hier content over.',
      priority: 'high',
      status: 'new',
      action_taken: false,
      confidence: 0.88,
      data_basis: { bron: 'competitor_analysis', type: 'positioning' },
    },
    {
      bedrijf: ipvgId,
      suggestion_type: 'content_idea',
      title: 'Blog: "Contact center software voor de zorg: waar let je op?"',
      description: 'Jullie hebben grote zorgklanten op Mitel met callcenters. Esprit ICT profileert zich als zorg-specialist. Claim deze positie ook online met een uitgebreid blogartikel.',
      priority: 'high',
      status: 'new',
      action_taken: false,
      confidence: 0.85,
      data_basis: { bron: 'cold_lead_plan', keyword: 'contact center zorg', type: 'blog' },
    },

    // ===== IJS UIT DE POLDER =====
    {
      bedrijf: ijsId,
      suggestion_type: 'competitor_move',
      title: 'Gebo Gelato inhalen op Facebook — doorzetten!',
      description: 'Jullie zijn al aardig op weg. Gebo heeft fabrieksijs uit Vlissingen, jullie maken het zelf. Post "behind the scenes" content van de productiekeuken — laat het verschil zien zonder Gebo te noemen.',
      priority: 'high',
      status: 'new',
      action_taken: false,
      confidence: 0.90,
      data_basis: { bron: 'competitor_analysis', concurrent: 'Gebo Gelato', platform: 'facebook' },
    },
    {
      bedrijf: ijsId,
      suggestion_type: 'performance_alert',
      title: 'Google reviews zijn 4-5 jaar oud',
      description: 'IJstraktatie heeft 31+ recente reviews. Jullie Google reviews zijn oud. Stuur na elk event een review-verzoek via email (kan via Resend automatisch). 10 nieuwe reviews = direct meer vertrouwen.',
      priority: 'urgent',
      status: 'new',
      action_taken: false,
      confidence: 0.93,
      data_basis: { bron: 'competitor_analysis', concurrent: 'IJstraktatie', metric: 'reviews' },
    },
    {
      bedrijf: ijsId,
      suggestion_type: 'content_idea',
      title: 'Seizoenscontent starten — het is april!',
      description: 'Piekseizoen begint. Post nu: nieuwe smaken, Bedford wordt klaargemaakt, eerste boekingen. Instagram Reels van de productiekeuken. TikTok behind-the-scenes. Dit is het moment.',
      priority: 'urgent',
      status: 'new',
      action_taken: false,
      confidence: 0.95,
      data_basis: { bron: 'seizoen', maand: 'april', type: 'seasonal' },
    },
    {
      bedrijf: ijsId,
      suggestion_type: 'content_idea',
      title: 'Blog: "IJswagen huren voor je bedrijfsfeest: de complete gids"',
      description: 'Bedrijfsevenementen zijn jullie grootste segment naast bruiloften. Deze zoekterm heeft volume en de concurrentie blogt hier niet over. Social server kan dit genereren.',
      priority: 'high',
      status: 'new',
      action_taken: false,
      confidence: 0.87,
      data_basis: { bron: 'seo', keyword: 'ijswagen huren bedrijfsfeest', type: 'blog' },
    },
    {
      bedrijf: ijsId,
      suggestion_type: 'audience_insight',
      title: 'Prijscalculator op website zoals IJstraktatie',
      description: 'IJstraktatie heeft een interactieve prijscalculator — bezoekers zien direct wat het kost. Dit verlaagt de drempel enorm. Jullie Moneybird offerte-flow is goed maar een calculator erbij zou meer leads opleveren.',
      priority: 'medium',
      status: 'new',
      action_taken: false,
      confidence: 0.82,
      data_basis: { bron: 'competitor_analysis', concurrent: 'IJstraktatie', type: 'conversion' },
    },

    // ===== IP VOICE SHOP =====
    {
      bedrijf: shopId,
      suggestion_type: 'performance_alert',
      title: 'Shop live krijgen — site nog onder constructie',
      description: 'De shop staat in maintenance mode. Prioriteit: Rank Math installeren, navigatie opbouwen, Mollie koppelen, homepage inrichten. Pas daarna SEO en marketing.',
      priority: 'urgent',
      status: 'new',
      action_taken: false,
      confidence: 0.98,
      data_basis: { bron: 'status_report', type: 'launch' },
    },
    {
      bedrijf: shopId,
      suggestion_type: 'competitor_move',
      title: 'DectDirect heeft 9.2 rating (1.440 reviews)',
      description: 'Kiyoh account aanmaken en vanaf dag 1 reviews verzamelen. Elke bestelling = review verzoek. Na 50 reviews ben je geloofwaardig. DectDirect en TelecomShop winnen nu op vertrouwen.',
      priority: 'high',
      status: 'new',
      action_taken: false,
      confidence: 0.90,
      data_basis: { bron: 'competitor_analysis', concurrent: 'DectDirect', metric: 'reviews' },
    },
    {
      bedrijf: shopId,
      suggestion_type: 'content_idea',
      title: 'Koopgidsen schrijven: "Beste headset voor Teams 2026"',
      description: 'SEO content die kopers aantrekt. Vergelijk 5 headsets, geef een aanbeveling, link naar producten in de shop. Social server blog module kan dit genereren.',
      priority: 'high',
      status: 'new',
      action_taken: false,
      confidence: 0.85,
      data_basis: { bron: 'seo', keyword: 'beste headset Teams', type: 'blog' },
    },
    {
      bedrijf: shopId,
      suggestion_type: 'audience_insight',
      title: 'USP: shop + expert advies + implementatie',
      description: 'Geen enkele concurrent biedt product + advies + implementatie + beheer. DectDirect verkoopt een headset. IP Voice Shop verkoopt een headset én kan je hele communicatie inrichten. Maak dit zichtbaar op elke productpagina: "Advies nodig? Bel onze specialisten."',
      priority: 'high',
      status: 'new',
      action_taken: false,
      confidence: 0.88,
      data_basis: { bron: 'competitor_analysis', type: 'positioning' },
    },
    {
      bedrijf: shopId,
      suggestion_type: 'content_idea',
      title: 'Google Shopping feed activeren',
      description: 'Met 9.000 producten en Google Merchant Center kun je gratis in Google Shopping verschijnen. Dit is de snelste manier om zichtbaar te worden naast DectDirect en Azerty.',
      priority: 'high',
      status: 'new',
      action_taken: false,
      confidence: 0.86,
      data_basis: { bron: 'seo', type: 'google_shopping' },
    },
  ];
}

async function seedSuggestions(suggestions: Suggestion[]) {
  for (const suggestion of suggestions) {
    if (!suggestion.bedrijf) {
      console.log(`  Skipping "${suggestion.title}" — bedrijf not found`);
      continue;
    }

    const res = await fetch(`${DIRECTUS_URL}/items/AI_Suggestions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(suggestion),
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`  ✓ ${suggestion.title} (ID: ${data.data.id})`);
    } else {
      const error = await res.text();
      console.error(`  ✗ ${suggestion.title} — ${res.status} ${error}`);
    }
  }
}

async function main() {
  console.log(`Directus: ${DIRECTUS_URL}\n`);

  const ipvgId = await getBedrijfId('IP Voice Group');
  const ijsId = await getBedrijfId('IJs uit de Polder');
  const shopId = await getBedrijfId('IP Voice Shop');

  console.log(`IP Voice Group: ${ipvgId}`);
  console.log(`IJs uit de Polder: ${ijsId}`);
  console.log(`IP Voice Shop: ${shopId}\n`);

  const suggestions = buildSuggestions(ipvgId, ijsId, shopId);
  console.log(`Seeding ${suggestions.length} AI suggestions...\n`);

  await seedSuggestions(suggestions);

  console.log(`\nDone! ${suggestions.length} suggestions created.`);
}

main().catch(console.error);
