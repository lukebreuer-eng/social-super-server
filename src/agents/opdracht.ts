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

// Uitvoer-tools: hiermee worden de adviseurs ook echte doeners. Alles blijft in de
// leerfase zichtbaar (concept ter review of een wijziging die je kunt terugdraaien);
// bij twijfel escaleert de agent in plaats van zelf door te zetten.
const legBemensingVast: ToolDef = {
  name: 'leg_bemensing_vast',
  description: 'Leg de bemensing (namen, komma-gescheiden) vast voor een event/boeking. Alleen als je zeker bent wie er gaat; anders escaleer.',
  input_schema: { type: 'object', properties: { eventId: { type: 'number' }, namen: { type: 'string' } }, required: ['eventId', 'namen'] },
  run: async (input, ctx) => {
    const { updateItem } = await import('@directus/sdk');
    const { directus } = await import('../config/directus');
    await directus.request(updateItem('Boekingen', input.eventId, { bemensing: String(input.namen) } as any));
    await ctx.log({ actie: 'leg_bemensing_vast', beslissing: `Bemensing event ${input.eventId}: ${input.namen}`, status: 'gedaan', resultaat_id: input.eventId });
    return { ok: true };
  },
};
const startCampagneTool: ToolDef = {
  name: 'start_campagne',
  description: 'Start een social-campagne voor een OPENBAAR event (geen privéboeking). Posts komen als concept ter review.',
  input_schema: { type: 'object', properties: { eventId: { type: 'number' } }, required: ['eventId'] },
  run: async (input, ctx) => {
    const { maakCampagne } = await import('./aanjager');
    const r = await maakCampagne(input.eventId);
    await ctx.log({ actie: 'start_campagne', beslissing: `Campagne (${r.aantal} posts) voor "${r.event}"`, status: 'concept' });
    return { ok: true, aantal: r.aantal };
  },
};
const maakEventTool: ToolDef = {
  name: 'maak_event',
  description: 'Maak een nieuw event/boeking aan in de agenda (voor een afspraak die nog niet in het systeem staat).',
  input_schema: { type: 'object', properties: { titel: { type: 'string' }, datum: { type: 'string' }, locatie: { type: 'string' }, type: { type: 'string' } }, required: ['titel', 'datum'] },
  run: async (input, ctx) => {
    const { voegEventToe } = await import('./aanjager');
    const r = await voegEventToe(ctx.bedrijfId, { titel: input.titel, event_datum: input.datum, locatie: input.locatie, event_type: input.type });
    await ctx.log({ actie: 'maak_event', beslissing: `Event aangemaakt: ${input.titel} (${input.datum})`, status: 'gedaan', resultaat_id: r.id });
    return { ok: true, id: r.id };
  },
};
const voerSeoActieTool: ToolDef = {
  name: 'voer_seo_actie',
  description: 'Voer de aanbevolen content-actie uit voor een zoekwoord-kans (nieuwe pagina, pagina verbeteren of blog). Levert een concept ter review.',
  input_schema: { type: 'object', properties: { query: { type: 'string' }, aanbeveling: { type: 'string' } }, required: ['query'] },
  run: async (input, ctx) => {
    const { voerAanbevelingUit } = await import('../seo/page-engine');
    const r = await voerAanbevelingUit(ctx.bedrijfId, input.query, { aanbeveling: input.aanbeveling });
    await ctx.log({ actie: 'voer_seo_actie', beslissing: `${r.type} voor "${input.query}"`, status: 'concept', resultaat_id: r.postId });
    return { ok: true, type: r.type };
  },
};
const startGeoScanTool: ToolDef = {
  name: 'start_geo_scan',
  description: 'Start een nieuwe GEO-scan (meet of we genoemd worden in AI-antwoorden). Draait op de achtergrond.',
  input_schema: { type: 'object', properties: {} },
  run: async (input, ctx) => {
    const { runGeoScan } = await import('../seo/geo-radar');
    runGeoScan(ctx.bedrijfId).catch(() => {});
    await ctx.log({ actie: 'start_geo_scan', beslissing: 'GEO-scan gestart', status: 'gedaan' });
    return { ok: true, gestart: true };
  },
};
const syncKostenTool: ToolDef = {
  name: 'sync_kosten',
  description: 'Haal de laatste kosten uit Moneybird op zodat de financiele cijfers actueel zijn.',
  input_schema: { type: 'object', properties: {} },
  run: async (input, ctx) => {
    const { syncKostenUitMoneybird } = await import('../finance/controller');
    await syncKostenUitMoneybird(ctx.bedrijfId);
    await ctx.log({ actie: 'sync_kosten', beslissing: 'Kosten gesynct uit Moneybird', status: 'gedaan' });
    return { ok: true };
  },
};

const neemOffertesInPlanning: ToolDef = {
  name: 'neem_offertes_in_planning',
  description: 'Haal de nieuwste getekende offertes uit Moneybird op en verwerk ze naar de planning (datum, locatie en middel uit de offerte). Gebruik dit als er een getekende offerte is die nog niet in de planning staat.',
  input_schema: { type: 'object', properties: {} },
  run: async (input, ctx) => {
    const { syncOffertes } = await import('../finance/offerte-sync');
    const sync = await syncOffertes(ctx.bedrijfId);
    const { laadMoneybirdHistorie } = await import('./historie-loader');
    const parse = await laadMoneybirdHistorie(ctx.bedrijfId);
    await ctx.log({ actie: 'neem_offertes_in_planning', beslissing: `Moneybird gesynct (${sync.nieuw} nieuw, ${sync.gewonnen} gewonnen); ${parse.bijgewerkt} boeking(en) kregen een planningsdatum, ${parse.zonder_datum} nog zonder datum`, status: 'gedaan' });
    return { nieuw: sync.nieuw, gewonnen: sync.gewonnen, in_planning_gezet: parse.bijgewerkt, nog_zonder_datum: parse.zonder_datum };
  },
};
const bekijkOpvolglijst: ToolDef = {
  name: 'bekijk_opvolglijst',
  description: 'Bekijk de offertes die opvolging nodig hebben (bijna verlopen + verlopen), met waarde, urgentie en reden.',
  input_schema: { type: 'object', properties: {} },
  run: async (input, ctx) => {
    const { getOpvolgLijst } = await import('../finance/sales-agent');
    const r = await getOpvolgLijst(ctx.bedrijfId);
    return { terugwinbaar: r.terugwinbaar, items: r.items.slice(0, 15).map((i) => ({ id: i.id, naam: i.contact_naam, waarde: i.waarde, urgentie: i.urgentie, actie: i.actie, reden: i.reden })) };
  },
};
const draftOpvolgmail: ToolDef = {
  name: 'draft_opvolgmail',
  description: 'Zet een persoonlijke opvolg-mail klaar als concept (in de platform-inbox en mailbox) voor een offerte. Gebruik het boeking-id uit de opvolglijst.',
  input_schema: { type: 'object', properties: { boekingId: { type: 'number' } }, required: ['boekingId'] },
  run: async (input, ctx) => {
    const { draftOpvolgNaarMailbox } = await import('../finance/sales-agent');
    const r = await draftOpvolgNaarMailbox(input.boekingId);
    await ctx.log({ actie: 'draft_opvolgmail', beslissing: `Opvolg-mail klaargezet: ${r.onderwerp}`, status: 'concept', resultaat_id: input.boekingId });
    return { ok: true, onderwerp: r.onderwerp };
  },
};

// Per agent een eigen persona + focus. We noemen ze gewoon bij hun functie. Ze delen de
// brede lees-tools (zodat ze echt kunnen antwoorden) plus een eigen uitvoer-tool.
const PERSONAS: Record<string, { naam: string; doel: string; tools: ToolDef[] }> = {
  dirigent:  { naam: 'Dirigent',  tools: [...leesTools, ...actieTools, neemOffertesInPlanning], doel: OPDRACHT_DOEL },
  mail:      { naam: 'Mail',      tools: [...leesTools, maakTaak, maakEventTool], doel: `Je bent de mail- en klantagent van IJs uit de Polder. Je kent het mailverkeer en de klantgeschiedenis. Beantwoord vragen over klanten, mails en afspraken (gebruik zoek_in_mail). Je kunt zelf een afspraak/event aanmaken met maak_event als dat duidelijk uit een mail volgt.` + SLOT },
  planning:  { naam: 'Planning',  tools: [...leesTools, maakTaak, legBemensingVast, neemOffertesInPlanning], doel: `Je bent de planningsagent. Je koppelt crew en middelen aan events en bewaakt conflicten (gebruik bekijk_planning en bekijk_agenda). Een getekende offerte uit Moneybird kun je met neem_offertes_in_planning ophalen en in de planning zetten. Als je zeker weet wie er gaat, leg je de bemensing zelf vast met leg_bemensing_vast; bij twijfel escaleer je.` + SLOT },
  seo:       { naam: 'SEO',       tools: [...leesTools, maakTaak, voerSeoActieTool], doel: `Je bent de SEO-agent. Je kent de Google-zoekdata en content-kansen (gebruik bekijk_zoekkansen). Voor een sterke kans kun je de content-actie zelf uitvoeren met voer_seo_actie (concept ter review).` + SLOT },
  geo:       { naam: 'GEO',       tools: [...leesTools, maakTaak, startGeoScanTool], doel: `Je bent de GEO-agent. Je meet of IJs uit de Polder genoemd wordt in AI-antwoorden (gebruik bekijk_ai_zichtbaarheid). Je kunt een verse meting starten met start_geo_scan. Zeg eerlijk waar we zichtbaar zijn en waar niet.` + SLOT },
  finance:   { naam: 'Finance',   tools: [...leesTools, maakTaak, syncKostenTool], doel: `Je bent de finance-agent. Omzet, kosten, marges, debiteuren en groeiadvies (gebruik bekijk_financien). Je kunt de kosten verversen uit Moneybird met sync_kosten. Geef nuchtere, concrete financiele inzichten.` + SLOT },
  campagnes: { naam: 'Campagnes', tools: [...leesTools, maakTaak, startCampagneTool], doel: `Je bent de campagne-agent. Je maakt social-campagnes voor OPENBARE events (nooit privéboekingen). Gebruik bekijk_agenda, en start zelf een campagne met start_campagne voor een openbaar event zonder campagne (posts komen als concept).` + SLOT },
  sales:     { naam: 'Sales',     tools: [...leesTools, bekijkOpvolglijst, maakTaak, draftOpvolgmail, neemOffertesInPlanning], doel: `Je bent de sales-agent. Je jaagt op offerte-opvolging: bijna verlopen en verlopen offertes terugwinnen (gebruik bekijk_opvolglijst). Voor een kansrijke offerte zet je met draft_opvolgmail een persoonlijke opvolg-mail als concept klaar. Een net getekende offerte kun je met neem_offertes_in_planning ophalen en in de planning zetten. Bij gevoelige of dode offertes escaleer je of stel je opruimen voor.` + SLOT },
};

export type OpdrachtAgent = 'dirigent' | 'marketing' | 'mail' | 'finance' | 'sales' | 'planning' | 'seo' | 'geo' | 'campagnes';

const GELDIGE_AGENTEN: OpdrachtAgent[] = ['dirigent', 'marketing', 'mail', 'finance', 'sales', 'planning', 'seo', 'geo', 'campagnes'];
/** Valideer de gekozen agent; val terug op dirigent bij onbekend. */
export function geldigeAgent(a: any): OpdrachtAgent {
  return GELDIGE_AGENTEN.includes(a) ? a : 'dirigent';
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

  if (agent === 'marketing') {
    const { marketeerOpdracht } = await import('./marketeer');
    return marketeerOpdracht(bedrijfId, tekst, hist);
  }

  const p = PERSONAS[agent] || PERSONAS.dirigent;
  const { getKennisbankContext } = await import('./kennisbank');
  const doel = p.doel + (await getKennisbankContext(bedrijfId));
  return runAgent(
    { naam: p.naam, doel, tools: p.tools, maxStappen: 10 },
    { bedrijfId, gebeurtenis: `Gesprek met Luke: ${tekst.slice(0, 120)}`, invoer: tekst, geschiedenis: hist }
  );
}
