import { directus } from '../config/directus';
import { readItems } from '@directus/sdk';
import { logger } from '../utils/logger';

export interface Actie { prio: number; icoon: string; tekst: string; route: string }
export interface Dagbriefing {
  bedrijfId: number;
  datum: string;
  kpis: {
    omzet_prognose: number | null;
    op_koers: boolean | null;
    opvolgen_aantal: number;
    terugwinbaar: number;
    debiteuren_totaal: number;
    content_te_schrijven: number;
    blogs_review: number;
    geo_mention_rate: number | null;
    leads_open: number;
  };
  acties: Actie[];
}

/**
 * Maestro, de dirigent: knoopt alle agents samen tot één ochtend-briefing.
 * Geen losse tabjes meer, maar "wat moet er vandaag gebeuren", geprioriteerd.
 */
export async function getDagbriefing(bedrijfId: number): Promise<Dagbriefing> {
  const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch((e) => { logger.warn('Maestro deelbron faalde:', e); return fallback; });

  const [opvolg, forecast, debiteuren, content, geo, reviewPosts, leads] = await Promise.all([
    safe(import('../finance/sales-agent').then((m) => m.getOpvolgLijst(bedrijfId)), null as any),
    safe(import('../finance/finance-overview').then((m) => m.getForecast(bedrijfId)), null as any),
    safe(import('../finance/finance-overview').then((m) => m.getDebiteuren(bedrijfId)), null as any),
    safe(import('../seo/content-map').then((m) => m.getContentMap(bedrijfId)), null as any),
    safe(import('../seo/geo-radar').then((m) => m.getGeoOverview(bedrijfId)), null as any),
    safe(directus.request(readItems('Posts', { filter: { bedrijf: { _eq: bedrijfId }, approval_status: { _eq: 'pending_review' } }, fields: ['id'], limit: -1 })) as Promise<any[]>, []),
    safe(directus.request(readItems('Leads', { filter: { bedrijf: { _eq: bedrijfId } }, fields: ['id', 'status'], limit: -1 })) as Promise<any[]>, []),
  ]);

  const opvolgen_aantal = opvolg?.items?.filter((i: any) => i.actie === 'opvolgen').length || 0;
  const terugwinbaar = opvolg?.terugwinbaar || 0;
  const debiteuren_totaal = debiteuren?.totaal || 0;
  const content_te_schrijven = content?.totals?.planned || 0;
  const blogs_review = reviewPosts.length;
  const geo_mention_rate = geo?.totals?.mention_rate ?? null;
  const leads_open = leads.filter((l: any) => !['gewonnen', 'verloren', 'closed', 'won', 'lost'].includes(String(l.status || '').toLowerCase())).length;

  const acties: Actie[] = [];
  if (opvolgen_aantal > 0) acties.push({ prio: 1, icoon: '🎯', tekst: `${opvolgen_aantal} offertes opvolgen, ${Math.round(terugwinbaar)} euro terug te winnen`, route: '#/sales' });
  if (debiteuren_totaal > 0) acties.push({ prio: 2, icoon: '🧾', tekst: `${Math.round(debiteuren_totaal)} euro aan openstaande facturen, mogelijk aanmanen`, route: '#/finance' });
  if (blogs_review > 0) acties.push({ prio: 3, icoon: '✍️', tekst: `${blogs_review} blogs wachten op je review`, route: '#/posts' });
  if (leads_open > 0) acties.push({ prio: 2, icoon: '🎯', tekst: `${leads_open} open leads om op te volgen`, route: '#/leads' });
  if (geo_mention_rate != null && geo_mention_rate < 50) acties.push({ prio: 4, icoon: '📡', tekst: `Je wordt maar in ${geo_mention_rate}% van de AI-antwoorden genoemd, content nodig`, route: '#/geo' });
  if (content_te_schrijven > 0) acties.push({ prio: 5, icoon: '🗺️', tekst: `${content_te_schrijven} keywords nog te schrijven in de content map`, route: '#/content-map' });
  if (forecast && forecast.op_pace === false) acties.push({ prio: 1, icoon: '🔮', tekst: `Omzet ligt ${Math.abs(forecast.vs_vorig_pct || 0)}% achter op vorig jaar, actie nodig`, route: '#/finance' });
  acties.sort((a, b) => a.prio - b.prio);

  return {
    bedrijfId,
    datum: new Date().toISOString().slice(0, 10),
    kpis: {
      omzet_prognose: forecast?.prognose ?? null,
      op_koers: forecast?.op_pace ?? null,
      opvolgen_aantal, terugwinbaar, debiteuren_totaal,
      content_te_schrijven, blogs_review, geo_mention_rate, leads_open,
    },
    acties,
  };
}
