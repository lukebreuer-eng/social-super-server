import Anthropic from '@anthropic-ai/sdk';
import { directus } from '../config/directus';
import { readItems, createItem } from '@directus/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export interface GeoOverview {
  bedrijfId: number;
  laatste_scan: string | null;
  totals: { prompts: number; mention_rate: number; cited_rate: number; avg_position: number | null };
  share_of_voice: Array<{ naam: string; mentions: number; aandeel: number; is_ons: boolean }>;
  prompts: Array<{
    id: number; vraag: string; intent: string; mentioned: boolean; cited: boolean;
    position: number | null; competitors_found: string[]; bronnen: string[]; antwoord_excerpt: string;
  }>;
}

// Normaliseer voor matching: kleine letters, accenten en leestekens weg. Zo matcht
// "IJs uit de Polder" ook op "ijs-uit-de-polder" of "ijs  uit de polder".
function norm(s: string): string {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function firstIndex(haystack: string, needles: string[]): number {
  let best = -1;
  for (const n of needles) {
    const i = haystack.indexOf(norm(n));
    if (i >= 0 && (best === -1 || i < best)) best = i;
  }
  return best;
}

/** Draait een GEO-scan: stelt elke actieve prompt aan Claude met web_search en slaat de mention/citatie op. */
export async function runGeoScan(bedrijfId: number): Promise<{ run_id: string; prompts: number }> {
  const prompts = (await directus.request(
    readItems('GEO_Prompts', { filter: { bedrijf: { _eq: bedrijfId }, actief: { _eq: true } }, limit: -1 })
  )) as any[];

  const run_id = new Date().toISOString();
  logger.info(`GEO scan start bedrijf ${bedrijfId}: ${prompts.length} prompts (run ${run_id})`);

  for (const p of prompts) {
    try {
      const resp: any = await anthropic.messages.create({
        model: env.ANTHROPIC_MODEL,
        max_tokens: 1024,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 } as any],
        messages: [{ role: 'user', content: String(p.vraag) }],
      });

      let answer = '';
      const bronnen: string[] = [];
      for (const block of resp.content || []) {
        if (block.type === 'text') answer += block.text + '\n';
        if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
          for (const r of block.content) if (r && r.url) bronnen.push(r.url);
        }
      }
      const lower = norm(answer);
      const aliassen: string[] = Array.isArray(p.aliassen) ? p.aliassen : [];
      const concurrenten: string[] = Array.isArray(p.concurrenten) ? p.concurrenten : [];
      const domein = aliassen.find((a) => a.includes('.')) || '';

      const inTekst = aliassen.some((a) => lower.includes(norm(a)));
      const cited = !!domein && bronnen.some((u) => u.toLowerCase().includes(domein.toLowerCase()));
      // Eerlijk: je bent "zichtbaar" in het AI-antwoord als je bij naam genoemd wordt
      // OF als je site als bron geciteerd wordt. Anders mis je vermeldingen waar de
      // assistent je site wel gebruikt maar je merknaam niet uitschrijft.
      const mentioned = inTekst || cited;
      const competitors_found = concurrenten.filter((c) => lower.includes(norm(c)));

      // positie: hoeveel merken (concurrenten) genoemd worden vóór onze eerste vermelding
      let position: number | null = null;
      if (inTekst) {
        const ours = firstIndex(lower, aliassen);
        const before = competitors_found.filter((c) => {
          const ci = lower.indexOf(c.toLowerCase());
          return ci >= 0 && ci < ours;
        }).length;
        position = before + 1;
      }

      await directus.request(createItem('GEO_Scans', {
        bedrijf: bedrijfId, prompt: p.id, data_source: 'claude_web', run_id,
        mentioned, cited, position, competitors_found,
        antwoord_excerpt: answer.slice(0, 600), bronnen,
      }));
    } catch (error) {
      logger.warn(`GEO scan prompt ${p.id} faalde:`, error);
    }
  }

  logger.info(`GEO scan klaar bedrijf ${bedrijfId} (run ${run_id})`);
  return { run_id, prompts: prompts.length };
}

/** Leest de laatste scan-run en aggregeert tot het dashboard-model. */
export async function getGeoOverview(bedrijfId: number): Promise<GeoOverview> {
  const [scans, prompts] = await Promise.all([
    directus.request(readItems('GEO_Scans', { filter: { bedrijf: { _eq: bedrijfId } }, sort: ['-run_id'], limit: -1 })) as Promise<any[]>,
    directus.request(readItems('GEO_Prompts', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 })) as Promise<any[]>,
  ]);

  if (scans.length === 0) {
    return { bedrijfId, laatste_scan: null, totals: { prompts: prompts.length, mention_rate: 0, cited_rate: 0, avg_position: null }, share_of_voice: [], prompts: [] };
  }

  const laatste = scans[0].run_id;
  const run = scans.filter((s) => s.run_id === laatste);
  const promptById = new Map(prompts.map((p) => [p.id, p]));

  const mentions = run.filter((s) => s.mentioned).length;
  const cites = run.filter((s) => s.cited).length;
  const posList = run.filter((s) => s.position != null).map((s) => Number(s.position));
  const round = (n: number) => Math.round(n * 10) / 10;

  // share of voice: ons + concurrenten over de run
  const sov = new Map<string, number>();
  let onsTotaal = 0;
  const onsNaam = (promptById.get(run[0].prompt)?.aliassen?.[0]) || 'Wij';
  for (const s of run) {
    if (s.mentioned) { onsTotaal++; }
    for (const c of (s.competitors_found || [])) sov.set(c, (sov.get(c) || 0) + 1);
  }
  const totaalMentions = onsTotaal + [...sov.values()].reduce((a, b) => a + b, 0);
  const share_of_voice = [
    { naam: onsNaam, mentions: onsTotaal, is_ons: true },
    ...[...sov.entries()].map(([naam, m]) => ({ naam, mentions: m, is_ons: false })),
  ].map((x) => ({ ...x, aandeel: totaalMentions ? round((x.mentions / totaalMentions) * 100) : 0 }))
   .sort((a, b) => b.mentions - a.mentions);

  return {
    bedrijfId,
    laatste_scan: laatste,
    totals: {
      prompts: run.length,
      mention_rate: round((mentions / run.length) * 100),
      cited_rate: round((cites / run.length) * 100),
      avg_position: posList.length ? round(posList.reduce((a, b) => a + b, 0) / posList.length) : null,
    },
    share_of_voice,
    prompts: run.map((s) => {
      const p = promptById.get(s.prompt) || {};
      return {
        id: s.prompt, vraag: String(p.vraag || ''), intent: String(p.intent || ''),
        mentioned: !!s.mentioned, cited: !!s.cited, position: s.position ?? null,
        competitors_found: s.competitors_found || [], bronnen: s.bronnen || [],
        antwoord_excerpt: String(s.antwoord_excerpt || ''),
      };
    }),
  };
}
