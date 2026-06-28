/**
 * Aanjager: de campagne-agent.
 *
 * Zet een geboekt event (Swim for Cancer, Havendagen, een bruiloft, ...) om in
 * een complete social-campagne: aankondiging, herinnering en een dag-zelf post,
 * in IJs-stem, automatisch ingepland rond de eventdatum. De posts komen als
 * concept (pending_review) klaar; na goedkeuring plaatst de publisher ze vanzelf
 * op de ingeplande momenten.
 *
 * Zo werken de agenten samen: een boeking (handmatig of uit Moneybird) -> Aanjager
 * -> social posts -> publisher.
 */

import Anthropic from '@anthropic-ai/sdk';
import { directus, db } from '../config/directus';
import { readItems, readItem, createItem, updateItem } from '@directus/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { stripDashes } from '../blog/blog-generator';

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export interface AgendaEvent {
  id: number;
  titel: string;
  locatie: string;
  event_datum: string;
  event_type: string;
  campagne_status: string;
  waarde: number;
  dagen_tot: number;
}

/** Aankomende events (boekingen met een eventdatum vanaf gisteren), op datum. */
export async function getAgenda(bedrijfId: number): Promise<AgendaEvent[]> {
  const gisteren = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const rows = (await directus.request(
    readItems('Boekingen', {
      filter: { bedrijf: { _eq: bedrijfId }, event_datum: { _gte: gisteren } } as any,
      sort: ['event_datum'], limit: -1,
    })
  )) as any[];
  const vandaag = Date.now();
  return rows
    .filter((b) => b.event_datum)
    .map((b) => ({
      id: b.id,
      titel: String(b.titel || b.contact_naam || 'Event'),
      locatie: String(b.locatie || b.contact_plaats || ''),
      event_datum: String(b.event_datum),
      event_type: String(b.event_type || ''),
      campagne_status: String(b.campagne_status || 'geen'),
      waarde: Number(b.waarde) || 0,
      dagen_tot: Math.round((new Date(b.event_datum).getTime() - vandaag) / 86400000),
    }));
}

export interface NieuwEvent { titel: string; event_datum: string; locatie?: string; event_type?: string; notitie?: string; waarde?: number; }

/** Voeg een event handmatig toe (bv. een boeking die niet in Moneybird staat). */
export async function voegEventToe(bedrijfId: number, ev: NieuwEvent): Promise<{ id: number }> {
  if (!ev.titel || !ev.event_datum) throw new Error('titel en event_datum zijn verplicht');
  const created = (await directus.request(
    createItem('Boekingen', {
      bedrijf: bedrijfId, bron: 'handmatig', status: 'gewonnen',
      titel: ev.titel, event_datum: ev.event_datum, locatie: ev.locatie || '',
      event_type: ev.event_type || '', notitie: ev.notitie || '',
      contact_naam: ev.titel, contact_plaats: ev.locatie || '',
      waarde: ev.waarde || 0, campagne_status: 'geen',
    } as any)
  )) as any;
  logger.info(`Event toegevoegd: "${ev.titel}" op ${ev.event_datum} (bedrijf ${bedrijfId})`);
  return { id: created.id };
}

interface CampagnePost { fase: string; dagen_voor: number; caption: string; hashtags: string[]; }

function parseCampagne(text: string): CampagnePost[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('Geen JSON-array in AI-antwoord');
  const arr = JSON.parse(m[0]) as any[];
  return arr.map((p) => ({
    fase: String(p.fase || ''),
    dagen_voor: Number(p.dagen_voor) || 0,
    caption: stripDashes(String(p.caption || '')),
    hashtags: Array.isArray(p.hashtags) ? p.hashtags : [],
  }));
}

export interface CampagneResult { event: string; aantal: number; posts: Array<{ fase: string; gepland: string; postId: number }>; }

/**
 * Genereer en plan een social-campagne voor een event. Posts komen als concept
 * (pending_review) met scheduled_at rond de eventdatum.
 */
export async function maakCampagne(boekingId: number): Promise<CampagneResult> {
  const b = (await directus.request(readItem('Boekingen', boekingId))) as any;
  if (!b) throw new Error(`Boeking ${boekingId} niet gevonden`);
  if (!b.event_datum) throw new Error('Dit event heeft nog geen datum. Vul eerst de eventdatum in.');

  const bedrijfId = Number(b.bedrijf);
  const bedrijf = (await directus.request(readItems('Bedrijven', { filter: { id: { _eq: bedrijfId } }, limit: 1 }))) as any[];
  const titel = String(b.titel || b.contact_naam || 'ons event');
  const locatie = String(b.locatie || b.contact_plaats || '');
  const type = String(b.event_type || 'ijskar');

  const prompt = `Je bent de social-media stem van IJs uit de Polder, ambachtelijke ijscatering uit Zeewolde. Warm, lokaal, menselijk, een vleugje trots en gezelligheid. GEEN gedachtestreepjes of em-dashes, gebruik komma's.

Maak een korte social-campagne van 3 posts rond dit event:
- Event: ${titel}
- Locatie: ${locatie || 'op locatie'}
- Datum: ${b.event_datum}
- Wat we meenemen: ${type}
${b.notitie ? `- Extra: ${b.notitie}` : ''}

De 3 posts:
1. fase "aankondiging" (dagen_voor 6): bouw voorpret op, vertel waar en wanneer we staan, nodig mensen uit langs te komen.
2. fase "herinnering" (dagen_voor 1): morgen is het zover, korte enthousiaste reminder.
3. fase "dag-zelf" (dagen_voor 0): we staan er nu, kom langs voor een bolletje.

Per post: pakkende tekst (max ~70 woorden), passend bij Facebook/Instagram, met relevante emoji's en een duidelijke uitnodiging.
Antwoord UITSLUITEND met een JSON-array: [{"fase","dagen_voor","caption","hashtags":[...]}].`;

  const resp = await anthropic.messages.create({ model: env.ANTHROPIC_MODEL, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] });
  const txt = resp.content.filter((c) => c.type === 'text').map((c) => (c as any).text).join('');
  const posts = parseCampagne(txt);

  const eventTs = new Date(`${b.event_datum}T11:00:00`).getTime();
  const out: CampagneResult['posts'] = [];
  for (const p of posts) {
    const scheduled = new Date(eventTs - p.dagen_voor * 86400000);
    const post = await db.createPost({
      title: `Campagne ${titel}: ${p.fase}`,
      caption: p.caption,
      hashtags: p.hashtags,
      bedrijf: bedrijfId,
      post_type: 'campagne',
      ai_generated: true,
      ai_confidence_score: 0.85,
      approval_status: 'pending_review',
      scheduled_at: scheduled.toISOString(),
      cta_link: bedrijf[0]?.website || '',
    } as any);
    out.push({ fase: p.fase, gepland: scheduled.toISOString().slice(0, 16).replace('T', ' '), postId: post.id });
  }

  await directus.request(updateItem('Boekingen', boekingId, { campagne_status: 'gemaakt' } as any));
  logger.info(`Aanjager: campagne (${out.length} posts) gemaakt voor "${titel}" op ${b.event_datum}`);
  return { event: titel, aantal: out.length, posts: out };
}
