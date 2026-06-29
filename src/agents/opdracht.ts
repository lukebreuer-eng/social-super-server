/**
 * Opdracht-agent: de "front office" waar Luke vrij een vraag stelt of een opdracht
 * geeft. De agent redeneert zelf, kijkt met zijn lees-tools naar de echte data
 * (briefing, zoekkansen, concurrenten, agenda, planning, financien, mail), en kan
 * werk uitzetten (Marketeer laten draaien) of een taak voor Luke aanmaken. Bij
 * twijfel of gevoeligheid: escaleren in plaats van zelf beslissen.
 *
 * Dit is geen vaste ronde maar een echte chat-/opdrachtingang: de invoer is wat
 * Luke typt. Antwoord komt terug in de samenvatting, alle stappen staan in het log.
 */

import { runAgent, ToolDef, AgentRunResult } from './runtime';
import { logger } from '../utils/logger';

const leesTools: ToolDef[] = [
  {
    name: 'bekijk_briefing',
    description: 'Haal de dagbriefing op: omzetprognose, op te volgen offertes, openstaande facturen, blogs ter review, GSC-kansen, AI-zichtbaarheid, aankomende events zonder campagne.',
    input_schema: { type: 'object', properties: {} },
    run: async (input, ctx) => {
      const { getDagbriefing } = await import('../dirigent/maestro');
      const b = await getDagbriefing(ctx.bedrijfId);
      return { kpis: b.kpis, acties: b.acties };
    },
  },
  {
    name: 'bekijk_zoekkansen',
    description: 'Content-kansen uit Google Search Console: zoekwoorden met veel vertoningen waar we net te laag staan, met per kans de aanbevolen actie.',
    input_schema: { type: 'object', properties: {} },
    run: async (input, ctx) => {
      const { getSpeurderOverzicht } = await import('../seo/page-engine');
      const o = await getSpeurderOverzicht(ctx.bedrijfId);
      return { totaal: o.kansen.length, top: o.kansen.slice(0, 10).map((k) => ({ query: k.query, impressies: k.impressies, positie: k.positie, aanbeveling: k.aanbeveling })) };
    },
  },
  {
    name: 'bekijk_ai_zichtbaarheid',
    description: 'GEO-overzicht: in hoeveel AI-antwoorden we genoemd worden en op welke vragen niet (proxy-meting via web-search, niet exact Google).',
    input_schema: { type: 'object', properties: {} },
    run: async (input, ctx) => {
      const { getGeoOverview } = await import('../seo/geo-radar');
      const g = await getGeoOverview(ctx.bedrijfId);
      return g?.totals ? { mention_rate: g.totals.mention_rate, gemiste_vragen: (g.prompts || []).filter((p: any) => !p.mentioned).map((p: any) => p.vraag) } : { geen_data: true };
    },
  },
  {
    name: 'bekijk_concurrenten',
    description: 'De bekende concurrenten met naam, platform, volgers en notities (sterktes/zwaktes).',
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
    description: 'Aankomende events/boekingen met datum, dagen-tot en campagne-status.',
    input_schema: { type: 'object', properties: {} },
    run: async (input, ctx) => {
      const { getAgenda } = await import('./aanjager');
      const a = await getAgenda(ctx.bedrijfId);
      return a.map((e) => ({ id: e.id, titel: e.titel, datum: e.event_datum, dagen_tot: e.dagen_tot, campagne: e.campagne_status, publiek: e.publiek }));
    },
  },
  {
    name: 'bekijk_planning',
    description: 'De ingeplande dagen met middel + bemensing en eventuele conflicten/alerts (van planner Spil).',
    input_schema: { type: 'object', properties: {} },
    run: async (input, ctx) => {
      const { planAgenda } = await import('./spil');
      const dagen = await planAgenda(ctx.bedrijfId);
      return dagen.slice(0, 12).map((d) => ({ datum: d.datum, alerts: d.alerts, events: d.events.map((e) => ({ titel: e.titel, middel: e.middel, bemensing: e.bemensing, alerts: e.alerts })) }));
    },
  },
  {
    name: 'bekijk_financien',
    description: 'Financieel overzicht: kosten per categorie, marges en het groeibeeld (van finance-controller).',
    input_schema: { type: 'object', properties: {} },
    run: async (input, ctx) => {
      const { getControllerOverzicht } = await import('../finance/controller');
      try { return await getControllerOverzicht(ctx.bedrijfId); }
      catch (e) { return { fout: (e as Error).message }; }
    },
  },
  {
    name: 'zoek_in_mail',
    description: 'Doorzoek het mail-archief op een trefwoord (klantnaam, onderwerp, plaats) en krijg de relevante berichten terug.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: async (input, ctx) => {
      const { zoekMail } = await import('./mail-archief');
      const r = await zoekMail(ctx.bedrijfId, String(input.query || ''), 8);
      return r.map((m: any) => ({ richting: m.richting, van: m.contact_email, onderwerp: m.onderwerp, datum: m.datum, fragment: String(m.tekst || '').slice(0, 300) }));
    },
  },
];

const actieTools: ToolDef[] = [
  {
    name: 'laat_marketeer_werken',
    description: 'Zet de marketing-agent aan het werk (zoekkansen en events oppakken, content/campagnes als concept). Gebruik dit als de opdracht om marketing-uitvoering vraagt.',
    input_schema: { type: 'object', properties: {} },
    run: async (input, ctx) => {
      const { marketeerRonde } = await import('./marketeer');
      const r = await marketeerRonde(ctx.bedrijfId);
      return { marketeer: r.samenvatting, acties: r.acties.length };
    },
  },
  {
    name: 'maak_taak',
    description: 'Maak een taak aan voor Luke/het team om iets op te volgen. Gebruik dit als er een concrete actie nodig is die jij niet zelf kunt of mag afhandelen.',
    input_schema: { type: 'object', properties: { titel: { type: 'string' }, omschrijving: { type: 'string' }, prioriteit: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] } }, required: ['titel'] },
    run: async (input, ctx) => {
      const { createItem } = await import('@directus/sdk');
      const { directus } = await import('../config/directus');
      const t = (await directus.request(createItem('Tasks', {
        title: String(input.titel), description: input.omschrijving ? String(input.omschrijving) : null,
        bedrijf: ctx.bedrijfId, status: 'open', priority: input.prioriteit || 'normal', category: 'other',
      } as any))) as any;
      await ctx.log({ actie: 'maak_taak', beslissing: `Taak aangemaakt: ${input.titel}`, status: 'gedaan', resultaat_id: t?.id });
      return { ok: true, taak_id: t?.id };
    },
  },
];

const SLOT = `\nBij twijfel, gevoeligheid (geld, klanten, toon) of iets onomkeerbaars: escaleer in plaats van zelf doen. Baseer je op je lees-tools, verzin niets. Voor iets dat een mens moet oppakken: maak_taak. Sluit af met 'klaar' en een helder, concreet antwoord in gewone taal. GEEN koppelstreepjes of em-dashes.`;

const OPDRACHT_DOEL = `Je bent de assistent/dirigent van IJs uit de Polder en handelt een vrije opdracht of vraag van Luke af. Begrijp eerst of het een vraag (uitzoeken) of opdracht (iets laten gebeuren) is. Voor marketing-uitvoering: laat_marketeer_werken.` + SLOT;

const maakTaak = actieTools.find((t) => t.name === 'maak_taak')!;

// Per agent een eigen persona + focus. Ze delen de brede lees-tools (zodat ze echt
// kunnen antwoorden), maar elke agent heeft zijn eigen rol en toon.
const PERSONAS: Record<string, { naam: string; doel: string; tools: ToolDef[] }> = {
  maestro:    { naam: 'Maestro',    tools: [...leesTools, ...actieTools], doel: OPDRACHT_DOEL },
  bode:       { naam: 'Bode',       tools: [...leesTools, maakTaak], doel: `Je bent Bode, de mail- en klantagent van IJs uit de Polder. Je kent het mailverkeer en de klantgeschiedenis. Beantwoord vragen over klanten, mails en afspraken; gebruik zoek_in_mail om in het archief te kijken.` + SLOT },
  spil:       { naam: 'Spil',       tools: [...leesTools, maakTaak], doel: `Je bent Spil, de planner. Je koppelt crew en middelen aan events en bewaakt conflicten. Gebruik bekijk_planning en bekijk_agenda en geef heldere planningsadviezen (wie, welk middel, welke dag).` + SLOT },
  speurder:   { naam: 'Speurder',   tools: [...leesTools, maakTaak], doel: `Je bent Speurder, de SEO-agent. Je kent de Google-zoekdata en content-kansen. Gebruik bekijk_zoekkansen en geef concrete SEO-adviezen (welk zoekwoord, welke pagina, welke actie).` + SLOT },
  spotter:    { naam: 'Spotter',    tools: [...leesTools, maakTaak], doel: `Je bent Spotter, de GEO-agent. Je meet of IJs uit de Polder genoemd wordt in AI-antwoorden. Gebruik bekijk_ai_zichtbaarheid en zeg eerlijk waar we zichtbaar zijn en waar niet.` + SLOT },
  controller: { naam: 'Controller', tools: [...leesTools, maakTaak], doel: `Je bent de Controller, de financien-agent. Omzet, kosten, marges, debiteuren en groeiadvies. Gebruik bekijk_financien en geef nuchtere, concrete financiele inzichten.` + SLOT },
  aanjager:   { naam: 'Aanjager',   tools: [...leesTools, maakTaak], doel: `Je bent Aanjager, de campagne-agent. Je adviseert over social-campagnes voor openbare events (geen privéboekingen). Gebruik bekijk_agenda en adviseer welke events een campagne verdienen en met welke insteek.` + SLOT },
};

export type OpdrachtAgent = 'maestro' | 'marketeer' | 'bode' | 'spil' | 'speurder' | 'spotter' | 'controller' | 'aanjager';

const GELDIGE_AGENTEN: OpdrachtAgent[] = ['maestro', 'marketeer', 'bode', 'spil', 'speurder', 'spotter', 'controller', 'aanjager'];
/** Valideer de gekozen agent; val terug op maestro bij onbekend. */
export function geldigeAgent(a: any): OpdrachtAgent {
  return GELDIGE_AGENTEN.includes(a) ? a : 'maestro';
}

export type GesprekBeurt = { role: 'user' | 'assistant'; content: string };

/**
 * Voer een vrije opdracht/vraag uit met de gekozen agent. Met optionele
 * gespreksgeschiedenis (eerdere beurten) zodat de agent kan doorpraten en
 * onthoudt wat er eerder gezegd is. Antwoord zit in samenvatting.
 */
export async function geefOpdracht(bedrijfId: number, agent: OpdrachtAgent, opdracht: string, geschiedenis: GesprekBeurt[] = []): Promise<AgentRunResult> {
  const tekst = String(opdracht || '').trim();
  if (!tekst) throw new Error('Lege opdracht');
  logger.info(`Gesprek met ${agent} voor bedrijf ${bedrijfId} (${geschiedenis.length} eerdere beurten): "${tekst.slice(0, 80)}"`);

  // Hou de geschiedenis behapbaar: laatste 12 beurten meesturen.
  const hist = geschiedenis.slice(-12);

  if (agent === 'marketeer') {
    const { marketeerOpdracht } = await import('./marketeer');
    return marketeerOpdracht(bedrijfId, tekst, hist);
  }

  const p = PERSONAS[agent] || PERSONAS.maestro;
  const { getKennisbankContext } = await import('./kennisbank');
  const doel = p.doel + (await getKennisbankContext(bedrijfId));
  return runAgent(
    { naam: p.naam, doel, tools: p.tools, maxStappen: 10 },
    { bedrijfId, gebeurtenis: `Gesprek met Luke: ${tekst.slice(0, 120)}`, invoer: tekst, geschiedenis: hist }
  );
}
