/**
 * Maestro als echte dirigent-agent op de runtime.
 *
 * Leest de dagbriefing (alle domeinen samengevat), bepaalt zelf de prioriteiten
 * voor vandaag, en kan taken uitdelen (bv. een marketingronde laten draaien).
 * Geeft een heldere, geprioriteerde sturing terug. Beslist niets onomkeerbaars.
 */

import { runAgent, ToolDef, AgentRunResult } from './runtime';
import { logger } from '../utils/logger';

const tools: ToolDef[] = [
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
    name: 'laat_marketeer_werken',
    description: 'Geef de marketing-agent opdracht een ronde te doen (zoekkansen en events oppakken). Gebruik dit als er duidelijke marketingkansen of events zonder campagne zijn.',
    input_schema: { type: 'object', properties: {} },
    run: async (input, ctx) => {
      const { marketeerRonde } = await import('./marketeer');
      const r = await marketeerRonde(ctx.bedrijfId);
      await ctx.log({ actie: 'laat_marketeer_werken', beslissing: `Marketeer deed ${r.stappen} acties`, status: 'gedaan' });
      return { marketeer: r.samenvatting, acties: r.acties.length };
    },
  },
];

const MAESTRO_DOEL = `Je bent Maestro, de dirigent van het IJs-leger. Je houdt het overzicht en stuurt.
Werkwijze: bekijk eerst de briefing. Bepaal de 3 belangrijkste prioriteiten voor vandaag (geld eerst: offertes opvolgen, openstaande facturen; dan events/campagnes; dan groei/marketing). Deel waar nuttig een taak uit (laat_marketeer_werken als er echte marketingkansen of events zonder campagne zijn). Sluit af met 'klaar' en een korte, heldere sturing: wat moet er vandaag gebeuren en wat heb jij in gang gezet. Hou het zakelijk en concreet, GEEN koppelstreepjes of em-dashes. Verzin geen cijfers, gebruik de briefing.`;

/** Laat Maestro een dirigent-ronde doen: briefing lezen, prioriteren, taken uitdelen. */
export async function maestroDirigeert(bedrijfId: number): Promise<AgentRunResult> {
  logger.info(`Maestro dirigeert voor bedrijf ${bedrijfId}`);
  return runAgent(
    { naam: 'Dirigent', doel: MAESTRO_DOEL, tools, maxStappen: 6 },
    { bedrijfId, gebeurtenis: 'Dagelijkse dirigent-ronde', invoer: 'Bekijk de briefing, bepaal de prioriteiten voor vandaag en deel taken uit waar nuttig. Geef daarna een heldere sturing.' }
  );
}
