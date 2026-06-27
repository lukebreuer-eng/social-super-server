import { Bedrijf } from '../config/directus';
import { cache } from '../config/redis';
import { logger } from '../utils/logger';

export interface SitePage {
  id: number;
  slug: string;
  title: string;
  link: string;
  text: string;
  featuredMedia: number;
  images: string[];
}

// Beelden die geen blogfoto mogen zijn (logo's, icoontjes, tracking pixels)
const SKIP_IMG = /logo|icon|favicon|sprite|placeholder|avatar|\.svg|data:|spinner|loader|1x1|pixel/i;

/** Haalt bruikbare afbeeldings-URLs uit WP-content HTML (page-builder beelden). */
function extractImages(html: string): string[] {
  const urls: string[] = [];
  const re = /<img[^>]+src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const src = m[1];
    if (src && /^https?:\/\//i.test(src) && !SKIP_IMG.test(src) && !urls.includes(src)) {
      urls.push(src);
    }
  }
  return urls;
}

// Slugs/patronen die nooit als bron-materiaal dienen (juridisch/utility)
const SKIP_SLUG = /privacy|verwerkersovereenkomst|vacature|cookie|algemene-voorwaarden|disclaimer|sitemap|bedankt|thank-you/i;

function stripHtml(html: string): string {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Haalt de gepubliceerde WP-pagina's van een bedrijf op (gecached per bedrijf, 6u).
 * Gebruikt het publieke WP REST endpoint, geen auth nodig voor published content.
 */
async function fetchSitePages(bedrijf: Bedrijf): Promise<SitePage[]> {
  const base = (bedrijf.website || '').replace(/\/$/, '');
  if (!base) return [];

  const cacheKey = `sitepages:${bedrijf.id}`;
  const cached = await cache.get<SitePage[]>(cacheKey);
  if (cached) return cached;

  try {
    const url = `${base}/wp-json/wp/v2/pages?per_page=100&status=publish&_fields=id,slug,title,link,content,featured_media`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      logger.warn(`Page fetch for ${base} returned ${res.status}`);
      return [];
    }
    const raw = (await res.json()) as Array<{
      id: number; slug: string; link: string; featured_media?: number;
      title: { rendered: string }; content: { rendered: string };
    }>;

    const pages: SitePage[] = raw
      .filter((p) => !SKIP_SLUG.test(p.slug))
      .map((p) => ({
        id: p.id,
        slug: p.slug,
        link: p.link,
        title: stripHtml(p.title?.rendered || ''),
        text: stripHtml(p.content?.rendered || ''),
        featuredMedia: p.featured_media || 0,
        images: extractImages(p.content?.rendered || ''),
      }))
      .filter((p) => p.text.length > 200); // lege/dunne pagina's overslaan

    await cache.set(cacheKey, pages, 6 * 3600);
    logger.info(`Fetched ${pages.length} site pages for ${bedrijf.title}`);
    return pages;
  } catch (error) {
    logger.warn(`Failed to fetch site pages for ${bedrijf.title}:`, error);
    return [];
  }
}

/** Resolved de URL van een uitgelichte afbeelding (featured_media id) via WP REST. */
async function resolveMediaUrl(bedrijf: Bedrijf, mediaId: number): Promise<string | null> {
  const base = (bedrijf.website || '').replace(/\/$/, '');
  if (!base || !mediaId) return null;
  try {
    const url = `${base}/wp-json/wp/v2/media/${mediaId}?_fields=source_url`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { source_url?: string };
    return data.source_url || null;
  } catch {
    return null;
  }
}

// Korte NL-stopwoorden die we negeren ook al zijn ze >= 2 tekens
const STOP = new Set(['de', 'het', 'een', 'en', 'of', 'je', 'je', 'op', 'te', 'in', 'om', 'voor', 'met', 'aan', 'uit', 'bij', 'naar', 'dan', 'als', 'wat', 'die', 'dat']);

/** Tokeniseert een string. Houdt betekenisvolle 2-letterwoorden (ai, cx) maar gooit stopwoorden weg. */
function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

/**
 * Kiest de meest relevante pagina's voor een keyword en bouwt bron-materiaal
 * dat in de generatie-prompt gaat. Titel/slug-matches wegen zwaarder dan body.
 */
export async function getPageContext(
  bedrijf: Bedrijf,
  keyword: string,
  maxPages = 3
): Promise<{ sourceText: string; pages: SitePage[]; featuredImage: string | null }> {
  const pages = await fetchSitePages(bedrijf);
  if (pages.length === 0) return { sourceText: '', pages: [], featuredImage: null };

  const kw = tokens(keyword);
  if (kw.length === 0) return { sourceText: '', pages: [], featuredImage: null };

  const scored = pages
    .map((p) => {
      const titleTokens = new Set(tokens(p.title + ' ' + p.slug));
      const bodyTokens = new Set(tokens(p.text).slice(0, 400));
      let score = 0;
      for (const t of kw) {
        if (titleTokens.has(t)) score += 5;
        else if (bodyTokens.has(t)) score += 1;
      }
      return { page: p, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPages);

  if (scored.length === 0) return { sourceText: '', pages: [], featuredImage: null };

  // Blogbeeld: eerst featured image van de hoogst scorende pagina, anders de
  // eerste bruikbare afbeelding uit de paginacontent (page-builder beeld).
  let featuredImage: string | null = null;
  for (const { page } of scored) {
    if (page.featuredMedia > 0) {
      featuredImage = await resolveMediaUrl(bedrijf, page.featuredMedia);
      if (featuredImage) break;
    }
  }
  if (!featuredImage) {
    for (const { page } of scored) {
      if (page.images.length > 0) {
        featuredImage = page.images[0];
        break;
      }
    }
  }

  const sourceText =
    '\n\nBRON-MATERIAAL VAN DE EIGEN WEBSITE (CRUCIAAL — gebruik deze ECHTE proposities, feiten, productnamen en formuleringen; verzin niets dat hier tegenin gaat):\n' +
    scored
      .map(({ page }) => `## ${page.title} (${page.link})\n${page.text.slice(0, 1800)}`)
      .join('\n\n');

  logger.info(
    `Page context for "${keyword}" (${bedrijf.title}): ${scored.map((s) => s.page.slug).join(', ')}`
  );

  return { sourceText, pages: scored.map((s) => s.page), featuredImage };
}
