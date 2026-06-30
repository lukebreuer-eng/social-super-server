/**
 * AI-verbruik bijhouden: na elke Anthropic-call leggen we het tokengebruik vast in
 * de collectie AI_Verbruik, met een geschatte kostprijs (tokens x publieke prijzen).
 * Dit is een schatting voor inzicht per dag/week/maand; het exacte gefactureerde
 * bedrag staat in console.anthropic.com.
 */

import { directus } from '../config/directus';
import { createItem } from '@directus/sdk';
import { logger } from '../utils/logger';

// Publieke prijzen in USD per miljoen tokens (input, output). Sleutel = deel van de model-id.
const PRIJZEN: Array<{ match: RegExp; in: number; out: number }> = [
  { match: /opus/i, in: 15, out: 75 },
  { match: /sonnet/i, in: 3, out: 15 },
  { match: /haiku/i, in: 0.8, out: 4 },
];

function prijs(model: string) {
  return PRIJZEN.find((p) => p.match.test(model)) || { in: 3, out: 15 };
}

/** Schat de kostprijs (USD) van een call op basis van tokens en model. */
export function schatKosten(model: string, inputTokens: number, outputTokens: number): number {
  const p = prijs(model);
  const usd = (inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out;
  return Math.round(usd * 10000) / 10000;
}

/** Leg een AI-call vast. Fire-and-forget: faalt dit, dan blokkeert het de agent niet. */
export function logVerbruik(bron: string, model: string, usage: any): void {
  try {
    const input = Number(usage?.input_tokens || 0) + Number(usage?.cache_read_input_tokens || 0) + Number(usage?.cache_creation_input_tokens || 0);
    const output = Number(usage?.output_tokens || 0);
    if (!input && !output) return;
    const kosten = schatKosten(model, input, output);
    directus
      .request(createItem('AI_Verbruik', { bron, model, input_tokens: input, output_tokens: output, kosten_usd: kosten } as any))
      .catch((e) => logger.warn(`AI-verbruik log faalde: ${(e as Error).message}`));
  } catch (e) {
    logger.warn(`AI-verbruik log fout: ${(e as Error).message}`);
  }
}
