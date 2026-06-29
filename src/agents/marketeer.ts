/**
 * Marketeer: de marketing-agent als echte redenerende agent.
 *
 * Bekijkt zelf de marketingkansen (zoekwoord-kansen uit GSC, AI-zichtbaarheid,
 * aankomende events) en beslist welke acties de meeste impact hebben, en voert
 * ze uit: content/pagina maken of een campagne starten. Eén marketingbrein over
 * alle kanalen, in plaats van losse knoppen.
 */

import { runAgent, ToolDef, AgentRunResult } from './runtime';
import { logger } from '../utils/logger';

const tools: ToolDef[] = [
  {
    name: 'bekijk_zoekkansen',
    description: 'Haal de content-kansen uit Google Search Console op: zoekwoorden met veel vertoningen waar we net te laag staan, met per kans de aanbevolen actie (pagina verbeteren / nieuwe pagina / blog).',
    input_schema: { type: 'object', properties: {} },
    run: async (input, ctx) => {
      const { getSpeurderOverzicht } = await import('../seo/page-engine');
      const o = await getSpeurderOverzicht(ctx.bedrijfId);
      return { totaal_kansen: o.kansen.length, top: o.kansen.slice(0, 10).map((k) => ({ query: k.query, impressies: k.impressies, positie: k.positie, aanbeveling: k.aanbeveling, top_url: k.top_url })) };
    },
  },
  {
    name: 'bekijk_ai_zichtbaarheid',
    description: 'Haal het GEO-overzicht op: in hoeveel AI-antwoorden we genoemd worden en op welke vragen niet (let op: dit is een proxy-meting, niet Google AI exact).',
    input_schema: { type: 'object', properties: {} },
    run: async (input, ctx) => {
      const { getGeoOverview } = await import('../seo/geo-radar');
      const g = await getGeoOverview(ctx.bedrijfId);
      return g?.totals ? { mention_rate: g.totals.mention_rate, gemiste_vragen: (g.prompts || []).filter((p: any) => !p.mentioned).map((p: any) => p.vraag) } : { geen_data: true };
    },
  },
  {
    name: 'bekijk_concurrenten',
    description: 'Haal de bekende concurrenten op (naam, platform, volgers en notities met sterktes/zwaktes), zodat je je content en campagnes kunt richten op waar wij ons onderscheiden en waar zij sterk zijn.',
    input_schema: { type: 'object', properties: {} },
    run: async (input, ctx) => {
      const { readItems } = await import('@directus/sdk');
      const { directus } = await import('../config/directus');
      const rows = (await directus.request(readItems('Competitors', { filter: { bedrijf: { _eq: ctx.bedrijfId } }, limit: -1 }))) as any[];
      return rows.map((c) => ({ naam: c.naam, platform: c.platform, volgers: c.follower_count || null, notities: c.notes || '' }));
    },
  },
  {
    name: 'bekijk_agenda',
    description: 'Haal aankomende events op met hun campagne-status, zodat je kunt beslissen of er nog een campagne nodig is.',
    input_schema: { type: 'object', properties: {} },
    run: async (input, ctx) => {
      const { getAgenda } = await import('./aanjager');
      const a = await getAgenda(ctx.bedrijfId);
      return a.map((e) => ({ id: e.id, titel: e.titel, datum: e.event_datum, dagen_tot: e.dagen_tot, campagne: e.campagne_status, publiek: e.publiek }));
    },
  },
  {
    name: 'maak_content',
    description: 'Voer de aanbevolen content-actie uit voor een zoekwoord-kans (blog, nieuwe dienstpagina, of bestaande pagina verbeteren). Levert een concept ter review.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, impressies: { type: 'number' }, aanbeveling: { type: 'string' }, top_url: { type: 'string' } }, required: ['query', 'aanbeveling'] },
    run: async (input, ctx) => {
      const { voerAanbevelingUit } = await import('../seo/page-engine');
      const r = await voerAanbevelingUit(ctx.bedrijfId, input.query, { impressies: input.impressies, aanbeveling: input.aanbeveling, top_url: input.top_url });
      await ctx.log({ actie: 'maak_content', beslissing: `${r.type} voor "${input.query}"`, status: 'concept', resultaat_id: r.postId || r.topicId });
      return { ok: true, type: r.type };
    },
  },
  {
    name: 'start_campagne',
    description: 'Laat Aanjager een social-campagne maken voor een aankomend event (als er nog geen campagne is). Posts komen als concept ter review.',
    input_schema: { type: 'object', properties: { eventId: { type: 'number' } }, required: ['eventId'] },
    run: async (input, ctx) => {
      const { maakCampagne } = await import('./aanjager');
      const r = await maakCampagne(input.eventId);
      await ctx.log({ actie: 'start_campagne', beslissing: `Campagne (${r.aantal} posts) voor "${r.event}"`, status: 'concept' });
      return { ok: true, aantal: r.aantal };
    },
  },
];

const MARKETEER_DOEL = `Je bent de marketing-agent van IJs uit de Polder. Je doel: meer boekingen en meer zichtbaarheid, lokaal in Flevoland en omstreken.
Werkwijze elke ronde:
1. Bekijk de zoekkansen, de AI-zichtbaarheid, de concurrenten en de agenda met je tools.
2. Gebruik de concurrent-informatie: kies hoeken waar wij ons onderscheiden (ambachtelijk, lokaal Flevoland, eigen ijskeuken) en speel in op gaten die concurrenten laten liggen. Kopieer concurrenten niet, positioneer ertegen.
3. Kies de 2 tot 3 acties met de meeste impact. Voorkom dubbel werk: niet 3 keer bijna hetzelfde (bv. losse pagina's voor ijssalon/ijs/ijswinkel zeewolde horen op één pagina).
4. Voer ze uit: maak_content voor sterke zoekkansen, start_campagne ALLEEN voor openbare events (publiek:true) zonder campagne. Maak NOOIT een campagne voor privéboekingen (publiek:false, zoals een ijsscooter of ijsbus voor een verjaardag of bedrijfsfeest): die zijn al geboekt en een publiekscampagne is dan onnodige vervuiling.
5. Alles wat je maakt is een concept ter review. Bij twijfel over richting of merk: escaleer.
Wees selectief en strategisch, geen content om de content. GEEN koppelstreepjes of em-dashes.`;

/** Laat Marketeer een marketingronde doen: kansen bekijken en de beste paar acties uitvoeren. */
export async function marketeerRonde(bedrijfId: number): Promise<AgentRunResult> {
  logger.info(`Marketeer doet een marketingronde voor bedrijf ${bedrijfId}`);
  const { getKennisbankContext } = await import('./kennisbank');
  const doel = MARKETEER_DOEL + (await getKennisbankContext(bedrijfId));
  return runAgent(
    { naam: 'Marketing', doel, tools, maxStappen: 10 },
    { bedrijfId, gebeurtenis: 'Marketingronde', invoer: 'Doe een marketingronde: bekijk de kansen en voer de 2 tot 3 acties met de meeste impact uit. Leg kort uit waarom je die koos.' }
  );
}

/** Voer een vrije marketing-opdracht/vraag van Luke uit, met optionele gespreksgeschiedenis. */
export async function marketeerOpdracht(bedrijfId: number, opdracht: string, geschiedenis: Array<{ role: 'user' | 'assistant'; content: string }> = []): Promise<AgentRunResult> {
  logger.info(`Marketeer krijgt opdracht voor bedrijf ${bedrijfId}`);
  const { getKennisbankContext } = await import('./kennisbank');
  const doel = MARKETEER_DOEL + (await getKennisbankContext(bedrijfId));
  return runAgent(
    { naam: 'Marketing', doel, tools, maxStappen: 10 },
    { bedrijfId, gebeurtenis: `Gesprek met Luke: ${String(opdracht).slice(0, 120)}`, invoer: String(opdracht), geschiedenis }
  );
}
