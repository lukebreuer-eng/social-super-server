/**
 * Intentie-bewuste content-engine.
 *
 * Niet blind blogs schrijven, maar per GSC-kans de juiste actie kiezen:
 *  - verbeter_pagina : er rankt al een echte pagina voor dit zoekwoord -> die
 *                      verbeteren (voorkomt dat een nieuwe blog je eigen pagina
 *                      kannibaliseert).
 *  - nieuwe_pagina   : geen pagina, en commerciële/lokale intentie -> een echte
 *                      dienst/landingspagina is beter dan een blog.
 *  - blog            : informatieve intentie, of er rankt al een blog -> blog.
 *
 * Alle uitvoer is een concept ter review; live klantpagina's worden nooit
 * automatisch aangepast.
 */

import { directus, Bedrijf } from '../config/directus';
import { readItems } from '@directus/sdk';
import { logger } from '../utils/logger';
import { getSitePages, SitePage } from '../blog/page-context';
import { getGscOverzicht, gokIntent, GscOverzicht, GscKans } from './gsc-sync';

export type Aanbeveling = 'verbeter_pagina' | 'nieuwe_pagina' | 'blog';

const AANBEVELING_LABEL: Record<Aanbeveling, string> = {
  verbeter_pagina: 'Verbeter pagina',
  nieuwe_pagina: 'Nieuwe pagina',
  blog: 'Blog',
};

export function aanbevelingLabel(a?: string): string {
  return AANBEVELING_LABEL[(a as Aanbeveling)] || 'Blog';
}

function normUrl(u: string): string {
  return String(u || '').toLowerCase().split('#')[0].split('?')[0].replace(/\/+$/, '');
}

function isHomepage(url: string, bedrijf: Bedrijf): boolean {
  const base = normUrl(bedrijf.website || '');
  return normUrl(url) === base;
}

function matchPagina(url: string, pages: SitePage[]): SitePage | null {
  const n = normUrl(url);
  return pages.find((p) => normUrl(p.link) === n) || null;
}

function lijktBlog(url: string): boolean {
  return /\/(blog|nieuws|news|artikel|article)\//i.test(url);
}

export interface KansClassificatie {
  aanbeveling: Aanbeveling;
  aanbeveling_reden: string;
  rankingType: 'pagina' | 'blog' | 'homepage' | 'geen';
  paginaId?: number;
  paginaTitel?: string;
}

/** Classificeer één kans: welke actie geeft de meeste winst en voorkomt kannibalisatie? */
export function classifyKans(kans: GscKans, bedrijf: Bedrijf, pages: SitePage[]): KansClassificatie {
  const intent = gokIntent(kans.query);
  const url = kans.top_url || '';
  const pagina = url ? matchPagina(url, pages) : null;

  if (pagina && !isHomepage(url, bedrijf)) {
    return {
      aanbeveling: 'verbeter_pagina',
      aanbeveling_reden: `Pagina "${pagina.title}" rankt al (pos ${kans.positie}). Verbeter die i.p.v. een concurrerende blog.`,
      rankingType: 'pagina', paginaId: pagina.id, paginaTitel: pagina.title,
    };
  }
  if (url && lijktBlog(url)) {
    return {
      aanbeveling: 'blog',
      aanbeveling_reden: `Er rankt al een blog (pos ${kans.positie}). Versterk/verbeter dat artikel.`,
      rankingType: 'blog',
    };
  }
  // Homepage rankt of helemaal niets: bij commercieel/lokaal is een eigen pagina beter.
  if (intent === 'commercial' || intent === 'transactional' || intent === 'local') {
    return {
      aanbeveling: 'nieuwe_pagina',
      aanbeveling_reden: url && isHomepage(url, bedrijf)
        ? `Alleen je homepage pakt dit nu op (pos ${kans.positie}). Een eigen dienstpagina rankt en converteert beter.`
        : `Commerciële/lokale zoekvraag zonder eigen pagina. Maak een gerichte dienst/landingspagina.`,
      rankingType: url ? 'homepage' : 'geen',
    };
  }
  return {
    aanbeveling: 'blog',
    aanbeveling_reden: 'Informatieve zoekvraag. Een blog is hier het beste.',
    rankingType: url ? 'homepage' : 'geen',
  };
}

export interface ActieResult {
  type: 'blog' | 'landingspagina' | 'pagina-verbetering';
  keyword: string;
  postId?: number;
  topicId?: number;
  title?: string;
  hergebruikt?: boolean;
}

/**
 * Voert de aanbevolen actie uit voor een kans. Routeert naar blog (Content Map),
 * nieuwe dienstpagina, of verbetervoorstel voor een bestaande pagina.
 * Alles als concept ter review.
 */
export async function voerAanbevelingUit(
  bedrijfId: number,
  query: string,
  opts: { impressies?: number; aanbeveling?: string; top_url?: string | null } = {}
): Promise<ActieResult> {
  const aanbeveling = (opts.aanbeveling || 'blog') as Aanbeveling;

  if (aanbeveling === 'nieuwe_pagina') {
    const { maakNieuwePagina } = await import('./page-writer');
    const r = await maakNieuwePagina(bedrijfId, query, opts.impressies);
    return { type: r.type, keyword: query, postId: r.postId, title: r.title };
  }
  if (aanbeveling === 'verbeter_pagina' && opts.top_url) {
    const { verbeterPagina } = await import('./page-writer');
    const r = await verbeterPagina(bedrijfId, query, opts.top_url);
    return { type: r.type, keyword: query, postId: r.postId, title: r.title };
  }
  // default: blog via Content Map
  const { kansNaarPagina } = await import('./gsc-sync');
  const r = await kansNaarPagina(bedrijfId, query, opts.impressies);
  return { type: 'blog', keyword: r.keyword, topicId: r.topicId, hergebruikt: r.hergebruikt };
}

async function getBedrijf(bedrijfId: number): Promise<Bedrijf | null> {
  const rows = (await directus.request(readItems('Bedrijven', { filter: { id: { _eq: bedrijfId } }, limit: 1 }))) as any[];
  return rows[0] || null;
}

export interface SpeurderOverzicht extends GscOverzicht {
  pagina_count: number;
}

/**
 * GSC-overzicht plus per kans een aanbeveling (pagina verbeteren / nieuwe pagina /
 * blog). Eén plek waar de Speurder-tab alles vandaan haalt.
 */
export async function getSpeurderOverzicht(bedrijfId: number): Promise<SpeurderOverzicht> {
  const overzicht = await getGscOverzicht(bedrijfId);
  let pages: SitePage[] = [];
  const bedrijf = await getBedrijf(bedrijfId);
  if (bedrijf) {
    try { pages = await getSitePages(bedrijf); } catch (e) { logger.warn('Speurder: site-pagina\'s ophalen faalde:', e); }
  }
  if (bedrijf) {
    for (const k of overzicht.kansen) {
      const c = classifyKans(k, bedrijf, pages);
      k.aanbeveling = c.aanbeveling;
      k.aanbeveling_reden = c.aanbeveling_reden;
    }
  }
  return { ...overzicht, pagina_count: pages.length };
}
