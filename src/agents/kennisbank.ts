/**
 * Gedeelde kennisbank-context voor alle agenten.
 *
 * Haalt de curated feiten uit AI_Knowledge_Base (wat IJs wel/niet is, middelen,
 * werkwijze) en levert een grounding-string die agenten in hun prompt krijgen,
 * zodat ze niets verzinnen en op de feiten en merktoon blijven.
 */

import { directus } from '../config/directus';
import { readItems } from '@directus/sdk';
import { cache } from '../config/redis';
import { logger } from '../utils/logger';

/** Geformatteerde kennisbank-feiten voor een bedrijf (gecached, 1u). */
export async function getKennisbankContext(bedrijfId: number): Promise<string> {
  const cacheKey = `kennisbank:${bedrijfId}`;
  const cached = await cache.get<string>(cacheKey);
  if (cached !== null && cached !== undefined) return cached;

  let context = '';
  try {
    const entries = (await directus.request(
      readItems('AI_Knowledge_Base', {
        filter: { bedrijf: { _eq: bedrijfId } } as any,
        fields: ['title', 'content', 'knowledge_type'],
        sort: ['-relevance_score'],
        limit: 50,
      })
    )) as Array<{ title: string; content: string; knowledge_type: string }>;

    if (entries.length) {
      context = '\n\nKENNISBANK (gebruik deze feiten, verzin niets dat hier niet staat):\n' +
        entries.map((k) => `- ${k.title}: ${k.content}`).join('\n');
    }
    logger.info(`Kennisbank: ${entries.length} entries geladen voor bedrijf ${bedrijfId}`);
  } catch (e) {
    logger.warn(`Kennisbank ophalen faalde: ${(e as Error).message}`);
  }

  await cache.set(cacheKey, context, 3600);
  return context;
}
