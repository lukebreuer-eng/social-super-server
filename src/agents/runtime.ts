/**
 * Agent-runtime: maakt van een agent een echte redenerende agent.
 *
 * Een agent krijgt een rol/doel + een gereedschapskist (tools). De runtime
 * draait een redeneer-loop: Claude beslist zélf welke tool hij gebruikt, wij
 * voeren 'm uit, geven het resultaat terug, en dat herhaalt tot de agent klaar
 * is. De stappen staan dus NIET in onze code, de AI bedenkt ze.
 *
 * Grenzen voor de leerfase:
 *  - max stappen (geen oneindige loops),
 *  - elke beslissing + actie wordt gelogd in Agent_Acties (zichtbaar op dashboard),
 *  - ingebouwde "escaleer"-tool: bij twijfel niet oversteken maar een alert geven.
 */

import Anthropic from '@anthropic-ai/sdk';
import { directus } from '../config/directus';
import { createItem } from '@directus/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (input: any, ctx: AgentContext) => Promise<unknown>;
}

export interface AgentDef {
  naam: string;
  doel: string;            // systeemprompt: rol, doelen, grenzen
  tools: ToolDef[];
  maxStappen?: number;
}

export interface AgentContext {
  bedrijfId: number;
  gebeurtenis: string;
  /** Log een actie/beslissing van de agent (zichtbaar op het Agenten-dashboard). */
  log: (entry: { actie: string; beslissing?: string; status?: string; detail?: unknown; resultaat_id?: number }) => Promise<void>;
}

export interface AgentRunResult {
  agent: string;
  stappen: number;
  acties: Array<{ actie: string; status: string }>;
  alerts: string[];
  samenvatting: string;
}

async function logActie(agent: string, bedrijfId: number, gebeurtenis: string, e: { actie: string; beslissing?: string; status?: string; detail?: unknown; resultaat_id?: number }) {
  try {
    await directus.request(createItem('Agent_Acties', {
      agent, bedrijf: bedrijfId, gebeurtenis,
      actie: e.actie, beslissing: e.beslissing || '',
      status: e.status || 'gedaan', twijfel: e.status === 'alert',
      detail: (e.detail as any) ?? null, resultaat_id: e.resultaat_id ?? null,
    } as any));
  } catch (err) {
    logger.warn(`Agent_Acties log faalde: ${(err as Error).message}`);
  }
}

const ESCALEER_TOOL = {
  name: 'escaleer',
  description: 'Gebruik dit als je twijfelt of een situatie te gevoelig/onduidelijk is om zelf af te handelen. Niet oversteken: zet een alert klaar zodat een mens beslist. Geef een duidelijke reden en wat je zou voorstellen.',
  input_schema: { type: 'object', properties: { reden: { type: 'string' }, voorstel: { type: 'string' } }, required: ['reden'] },
};
const KLAAR_TOOL = {
  name: 'klaar',
  description: 'Roep dit aan als je klaar bent. Geef een korte samenvatting van wat je hebt gedaan en besloten.',
  input_schema: { type: 'object', properties: { samenvatting: { type: 'string' } }, required: ['samenvatting'] },
};

/**
 * Draai een agent op een gebeurtenis. De agent redeneert en handelt zelf via
 * zijn tools, tot 'klaar' of het stappen-maximum.
 */
export async function runAgent(def: AgentDef, run: { bedrijfId: number; gebeurtenis: string; invoer: string; geschiedenis?: Array<{ role: 'user' | 'assistant'; content: string }> }): Promise<AgentRunResult> {
  const maxStappen = def.maxStappen || 8;
  const toolSchemas = [
    ...def.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as any })),
    ESCALEER_TOOL, KLAAR_TOOL,
  ];

  const ctx: AgentContext = {
    bedrijfId: run.bedrijfId,
    gebeurtenis: run.gebeurtenis,
    log: (e) => logActie(def.naam, run.bedrijfId, run.gebeurtenis, e),
  };

  const messages: Anthropic.MessageParam[] = [
    ...(run.geschiedenis || []).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: run.invoer },
  ];
  const acties: Array<{ actie: string; status: string }> = [];
  const alerts: string[] = [];
  let samenvatting = '';

  for (let stap = 0; stap < maxStappen; stap++) {
    const resp = await anthropic.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 1800,
      system: `Je bent ${def.naam}, een autonome AI-agent voor IJs uit de Polder.\n\n${def.doel}\n\nWerkwijze: redeneer kort, gebruik je tools om de situatie af te handelen, en roep 'klaar' aan als je klaar bent. Bij twijfel of gevoeligheid: gebruik 'escaleer' in plaats van zelf handelen. Verzin geen feiten.`,
      tools: toolSchemas,
      messages,
    });
    try { const { logVerbruik } = await import('../ai-engine/usage'); logVerbruik(`agent:${def.naam}`, env.ANTHROPIC_MODEL, (resp as any).usage); } catch (e) {}
    messages.push({ role: 'assistant', content: resp.content });

    const denk = resp.content.filter((c) => c.type === 'text').map((c) => (c as any).text).join(' ').trim();
    const toolUses = resp.content.filter((c) => c.type === 'tool_use') as Anthropic.ToolUseBlock[];

    if (!toolUses.length) { samenvatting = denk || samenvatting; break; }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let klaar = false;

    for (const tu of toolUses) {
      if (tu.name === 'klaar') {
        samenvatting = String((tu.input as any)?.samenvatting || denk || '');
        await ctx.log({ actie: 'klaar', beslissing: samenvatting, status: 'gedaan' });
        klaar = true;
        continue;
      }
      if (tu.name === 'escaleer') {
        const reden = String((tu.input as any)?.reden || '');
        const voorstel = String((tu.input as any)?.voorstel || '');
        alerts.push(reden);
        await ctx.log({ actie: 'escaleer', beslissing: `${reden}${voorstel ? ' | Voorstel: ' + voorstel : ''}`, status: 'alert', detail: tu.input });
        acties.push({ actie: 'escaleer', status: 'alert' });
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Alert geplaatst voor een mens. Handel dit niet zelf af.' });
        continue;
      }
      const tool = def.tools.find((t) => t.name === tu.name);
      if (!tool) {
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Onbekende tool: ${tu.name}`, is_error: true });
        continue;
      }
      let status = 'gedaan';
      let result: unknown;
      try {
        result = await tool.run(tu.input, ctx);
      } catch (e) {
        status = 'fout';
        result = { error: (e as Error).message };
      }
      await ctx.log({ actie: tu.name, beslissing: denk, status, detail: { input: tu.input, result } });
      acties.push({ actie: tu.name, status });
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 4000), is_error: status === 'fout' });
    }

    if (klaar) break;
    messages.push({ role: 'user', content: toolResults });
  }

  logger.info(`Agent ${def.naam}: ${acties.length} acties, ${alerts.length} alerts op gebeurtenis "${run.gebeurtenis}"`);
  return { agent: def.naam, stappen: acties.length, acties, alerts, samenvatting };
}
