import Anthropic from '@anthropic-ai/sdk';
import { directus } from '../config/directus';
import { readItems, readItem } from '@directus/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export interface OpvolgItem {
  id: number;
  contact_naam: string;
  waarde: number;
  vervaldatum: string | null;
  status: string;
  dagen: number | null;      // dagen tot vervaldatum (negatief = al verlopen)
  urgentie: 'verlopen' | 'bijna_verlopen' | 'open';
  referentie: string;
}

/**
 * De jacht: offertes die opvolging nodig hebben. Open offertes die bijna
 * verlopen (vóór ze weglekken) + al verlopen offertes (terugwinnen).
 * Gesorteerd op urgentie en waarde, met de totale terugwinbare omzet.
 */
export async function getOpvolgLijst(bedrijfId: number): Promise<{ items: OpvolgItem[]; terugwinbaar: number; aantal: number }> {
  const boekingen = (await directus.request(
    readItems('Boekingen', {
      filter: { bedrijf: { _eq: bedrijfId }, status: { _in: ['open', 'verlopen'] } },
      limit: -1,
    })
  )) as any[];

  const today = Date.now();
  const items: OpvolgItem[] = boekingen.map((b) => {
    const due = b.vervaldatum ? new Date(b.vervaldatum).getTime() : null;
    const dagen = due ? Math.round((due - today) / 86400000) : null;
    let urgentie: OpvolgItem['urgentie'] = 'open';
    if (b.status === 'verlopen' || (dagen !== null && dagen < 0)) urgentie = 'verlopen';
    else if (dagen !== null && dagen <= 7) urgentie = 'bijna_verlopen';
    return {
      id: b.id,
      contact_naam: String(b.contact_naam || 'Onbekend'),
      waarde: Number(b.waarde) || 0,
      vervaldatum: b.vervaldatum || null,
      status: b.status,
      dagen,
      urgentie,
      referentie: String(b.referentie || ''),
    };
  });

  const prio = { bijna_verlopen: 0, verlopen: 1, open: 2 };
  items.sort((a, b) => (prio[a.urgentie] - prio[b.urgentie]) || (b.waarde - a.waarde));

  const terugwinbaar = Math.round(items.reduce((s, i) => s + i.waarde, 0) * 100) / 100;
  return { items, terugwinbaar, aantal: items.length };
}

/**
 * De actie: schrijft een warme, persoonlijke opvolg-mail voor een offerte in
 * de toon van IJs uit de Polder (geen streepjes, menselijk, vriendelijk).
 */
export async function draftOpvolgMail(boekingId: number): Promise<{ onderwerp: string; body: string }> {
  const b = (await directus.request(readItem('Boekingen', boekingId))) as any;
  if (!b) throw new Error(`Boeking ${boekingId} niet gevonden`);

  const verlopen = b.status === 'verlopen';
  const prompt = `Je bent de vriendelijke salesmedewerker van IJs uit de Polder (ambachtelijke ijscatering uit Zeewolde). Schrijf een korte, warme opvolg-mail voor een openstaande offerte. Toon: persoonlijk, menselijk, nooit pusherig, een vleugje enthousiasme over ijs. GEEN gedachtestreepjes of em-dashes, gebruik komma's. Geen overdreven verkooppraat.

OFFERTE-GEGEVENS:
- Klant: ${b.contact_naam}
- Waarde: EUR ${Number(b.waarde || 0).toFixed(0)}
- Omschrijving/referentie: ${b.referentie || 'evenement met ijs'}
- Status: ${verlopen ? 'de offerte is verlopen zonder reactie, win de klant warm terug' : 'de offerte staat nog open en verloopt binnenkort, geef een vriendelijk duwtje'}

Schrijf het in het Nederlands. Geef JSON terug met exact deze velden: {"onderwerp": "...", "body": "..."}. De body is platte tekst met regelafbrekingen, klaar om te versturen, met een afsluiting namens het team van IJs uit de Polder.`;

  const resp = await anthropic.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = resp.content.find((c) => c.type === 'text');
  const raw = text && text.type === 'text' ? text.text : '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Geen JSON in AI-respons');
  const parsed = JSON.parse(m[0]);
  logger.info(`Opvolg-mail gedraft voor boeking ${boekingId} (${b.contact_naam})`);
  return { onderwerp: String(parsed.onderwerp || ''), body: String(parsed.body || '') };
}
