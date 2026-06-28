/**
 * Pagina-schrijver: genereert een dienst/landingspagina (nieuw) of een
 * verbetervoorstel voor een bestaande pagina, als concept ter review.
 *
 * Levert een Post op met post_type 'landingspagina' of 'pagina-verbetering',
 * approval_status 'pending_review'. Past nooit zelf een live pagina aan.
 */

import Anthropic from '@anthropic-ai/sdk';
import { directus, db, Bedrijf } from '../config/directus';
import { readItems } from '@directus/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { stripDashes } from '../blog/blog-generator';
import { getSitePages } from '../blog/page-context';

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

interface PageResult { title: string; metaTitle: string; metaDescription: string; content: string; tags: string[]; confidence: number; }

const STIJL = `
Schrijf in het Nederlands, in de tone of voice van het bedrijf. Menselijk, concreet, geen marketingclichés.
ABSOLUUT GEEN koppelstreepjes of gedachtestreepjes (— of –) in de tekst; gebruik gewone komma's of punten.
Geef HTML terug met <h2>/<h3>, <p>, <ul><li>, en minstens één duidelijke call-to-action.
Antwoord UITSLUITEND met JSON: {"title","meta_title","meta_description","content","tags":[...],"confidence_score"}.
De eerste tag MOET exact het doelzoekwoord zijn.`;

async function brandHeader(bedrijf: Bedrijf): Promise<string> {
  const { getKennisbankContext } = await import('../agents/kennisbank');
  const kb = await getKennisbankContext(bedrijf.id);
  return `Bedrijf: ${bedrijf.title}
Website: ${bedrijf.website}
Tone of voice: ${bedrijf.tone_of_voice || 'warm, lokaal, no-nonsense'}
Doelgroep: ${bedrijf.target_audience || ''}
USP's: ${(bedrijf.unique_selling_points || []).join('; ')}${kb}`;
}

function parse(text: string): PageResult {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Geen JSON in AI-antwoord');
  const d = JSON.parse(m[0]);
  return {
    title: stripDashes(d.title || 'Nieuwe pagina'),
    metaTitle: stripDashes(d.meta_title || d.title || ''),
    metaDescription: stripDashes(d.meta_description || ''),
    content: stripDashes(d.content || ''),
    tags: Array.isArray(d.tags) ? d.tags : [],
    confidence: Math.min(1, Math.max(0, d.confidence_score || 0.7)),
  };
}

async function getBedrijf(bedrijfId: number): Promise<Bedrijf> {
  const rows = (await directus.request(readItems('Bedrijven', { filter: { id: { _eq: bedrijfId } }, limit: 1 }))) as any[];
  if (!rows[0]) throw new Error(`Bedrijf ${bedrijfId} niet gevonden`);
  return rows[0];
}

export interface PaginaConceptResult { postId: number; title: string; type: 'landingspagina' | 'pagina-verbetering'; }

/** Genereer een nieuwe dienst/landingspagina voor een zoekwoord (concept ter review). */
export async function maakNieuwePagina(bedrijfId: number, keyword: string, impressies?: number): Promise<PaginaConceptResult> {
  const bedrijf = await getBedrijf(bedrijfId);
  const prompt = `${await brandHeader(bedrijf)}

Maak een sterke, converterende DIENST/LANDINGSPAGINA gericht op het zoekwoord: "${keyword}".
Dit is een commerciële/lokale zoekvraag met ${impressies ?? 'veel'} vertoningen per maand in Google, maar we hebben er nog geen eigen pagina voor.
Doel: bovenaan ranken én bezoekers laten boeken/contact opnemen. Bouw op met een pakkende H1, korte intro, concrete secties (wat, voor wie, hoe werkt het, waarom wij, prijsindicatie indien logisch), en een duidelijke CTA.
${STIJL}`;

  const resp = await anthropic.messages.create({ model: env.ANTHROPIC_MODEL, max_tokens: 3500, messages: [{ role: 'user', content: prompt }] });
  const txt = resp.content.filter((b) => b.type === 'text').map((b) => (b as any).text).join('');
  const page = parse(txt);
  const tags = page.tags.length && page.tags[0].toLowerCase() === keyword.toLowerCase() ? page.tags : [keyword, ...page.tags];

  const post = await db.createPost({
    title: page.title, caption: page.content, bedrijf: bedrijfId,
    post_type: 'landingspagina', ai_generated: true, ai_confidence_score: page.confidence,
    approval_status: 'pending_review', cta_link: bedrijf.website || '', cta_text: page.metaTitle,
    hashtags: tags, seo_focus_keyword: keyword, seo_title: page.metaTitle, seo_description: page.metaDescription,
    revision_notes: `Nieuwe dienstpagina voor zoekwoord "${keyword}" (${impressies ?? '?'} impressies/maand). Publiceer als WordPress-pagina.`,
  } as any);
  logger.info(`Landingspagina-concept ${post.id} aangemaakt voor "${keyword}" (bedrijf ${bedrijfId})`);
  return { postId: post.id, title: page.title, type: 'landingspagina' };
}

/** Genereer een verbetervoorstel voor een bestaande pagina die al rankt (concept ter review). */
export async function verbeterPagina(bedrijfId: number, keyword: string, bronUrl: string): Promise<PaginaConceptResult> {
  const bedrijf = await getBedrijf(bedrijfId);
  const pages = await getSitePages(bedrijf);
  const norm = (u: string) => String(u || '').toLowerCase().replace(/\/+$/, '').split('?')[0];
  const pagina = pages.find((p) => norm(p.link) === norm(bronUrl));
  const huidige = pagina ? pagina.text.slice(0, 4000) : '';

  const prompt = `${await brandHeader(bedrijf)}

We ranken al voor het zoekwoord "${keyword}", maar net te laag. De bestaande pagina is:
URL: ${bronUrl}
Titel: ${pagina?.title || '(onbekend)'}
Huidige inhoud (platte tekst, ingekort):
"""${huidige || '(kon de inhoud niet ophalen, schrijf een sterke verbeterde versie op basis van het zoekwoord)'}"""

Schrijf een VERBETERDE versie van deze pagina die hoger rankt op "${keyword}": behoud wat goed is en de feiten, maar maak het completer, beter gestructureerd (koppen, lijstjes), met de zoekintentie volledig beantwoord en een sterke CTA. Niet langer om het langer, wél vollediger en overtuigender.
${STIJL}`;

  const resp = await anthropic.messages.create({ model: env.ANTHROPIC_MODEL, max_tokens: 3500, messages: [{ role: 'user', content: prompt }] });
  const txt = resp.content.filter((b) => b.type === 'text').map((b) => (b as any).text).join('');
  const page = parse(txt);
  const tags = page.tags.length && page.tags[0].toLowerCase() === keyword.toLowerCase() ? page.tags : [keyword, ...page.tags];

  const post = await db.createPost({
    title: `Verbetering: ${page.title}`, caption: page.content, bedrijf: bedrijfId,
    post_type: 'pagina-verbetering', ai_generated: true, ai_confidence_score: page.confidence,
    approval_status: 'pending_review', cta_link: bronUrl, cta_text: page.metaTitle,
    hashtags: tags, seo_focus_keyword: keyword, seo_title: page.metaTitle, seo_description: page.metaDescription,
    revision_notes: `Verbetervoorstel voor bestaande pagina ${bronUrl} (zoekwoord "${keyword}"). Vervang de inhoud van die pagina na review.`,
  } as any);
  logger.info(`Pagina-verbetering ${post.id} aangemaakt voor "${keyword}" -> ${bronUrl}`);
  return { postId: post.id, title: page.title, type: 'pagina-verbetering' };
}
