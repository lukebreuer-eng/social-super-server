import Anthropic from '@anthropic-ai/sdk';
import { directus } from '../config/directus';
import { readItems, readItem, updateItem } from '@directus/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export interface OpvolgItem {
  id: number;
  contact_naam: string;
  waarde: number;
  vervaldatum: string | null;
  status: string;
  dagen: number | null;        // dagen tot vervaldatum (negatief = al verlopen)
  dagen_open: number | null;   // dagen sinds de offerte verstuurd is
  urgentie: 'verlopen' | 'bijna_verlopen' | 'open';
  actie: 'opvolgen' | 'opruimen';  // de slimme keuze: najagen of als dood opruimen
  reden: string;
  referentie: string;
}

/**
 * De jacht: offertes die opvolging nodig hebben. Open offertes die bijna
 * verlopen (vóór ze weglekken) + al verlopen offertes (terugwinnen).
 * Gesorteerd op urgentie en waarde, met de totale terugwinbare omzet.
 */
export async function getOpvolgLijst(bedrijfId: number): Promise<{ items: OpvolgItem[]; terugwinbaar: number; aantal: number; opruimen: number; al_gewonnen: number }> {
  const [boekingen, facturen, gewonnen] = await Promise.all([
    directus.request(readItems('Boekingen', { filter: { bedrijf: { _eq: bedrijfId }, status: { _in: ['open', 'verlopen'] } }, limit: -1 })) as Promise<any[]>,
    directus.request(readItems('Facturen', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 })) as Promise<any[]>,
    directus.request(readItems('Boekingen', { filter: { bedrijf: { _eq: bedrijfId }, status: { _eq: 'gewonnen' } }, limit: -1 })) as Promise<any[]>,
  ]);

  // Intelligentie: een offerte die al gefactureerd of als boeking gewonnen is, NIET najagen.
  const norm = (s: any) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const geconverteerd = new Set<string>();
  for (const f of facturen) if (norm(f.contact_naam)) geconverteerd.add(norm(f.contact_naam));
  for (const g of gewonnen) if (norm(g.contact_naam)) geconverteerd.add(norm(g.contact_naam));
  const isGeconverteerd = (naam: string) => {
    const n = norm(naam);
    if (!n || n.length < 3) return false;
    for (const c of geconverteerd) if (c.length >= 3 && (n === c || n.includes(c) || c.includes(n))) return true;
    return false;
  };

  const today = Date.now();
  const teVolgen = boekingen.filter((b) => !isGeconverteerd(b.contact_naam));
  const alGewonnen = boekingen.length - teVolgen.length;
  const items: OpvolgItem[] = teVolgen.map((b) => {
    const due = b.vervaldatum ? new Date(b.vervaldatum).getTime() : null;
    const dagen = due ? Math.round((due - today) / 86400000) : null;
    const sent = b.offerte_datum ? new Date(b.offerte_datum).getTime() : null;
    const dagen_open = sent ? Math.round((today - sent) / 86400000) : null;

    let urgentie: OpvolgItem['urgentie'] = 'open';
    if (b.status === 'verlopen' || (dagen !== null && dagen < 0)) urgentie = 'verlopen';
    else if (dagen !== null && dagen <= 7) urgentie = 'bijna_verlopen';

    // De slimme keuze: een offerte die te lang openstaat of ver verlopen is, is dood.
    // Najagen heeft dan geen zin (event is geweest), opruimen wel.
    let actie: OpvolgItem['actie'] = 'opvolgen';
    let reden = 'nog warm, kans om te winnen';
    if ((dagen_open !== null && dagen_open > 45) || (dagen !== null && dagen < -21)) {
      actie = 'opruimen';
      reden = dagen_open !== null && dagen_open > 45
        ? `${dagen_open} dagen open, event is waarschijnlijk geweest`
        : 'ruim verlopen, niet meer relevant';
    } else if (urgentie === 'bijna_verlopen') {
      reden = 'verloopt binnenkort, nu opvolgen';
    } else if (urgentie === 'verlopen') {
      reden = 'net verlopen, nog een kans waard';
    }

    return {
      id: b.id,
      contact_naam: String(b.contact_naam || 'Onbekend'),
      waarde: Number(b.waarde) || 0,
      vervaldatum: b.vervaldatum || null,
      status: b.status,
      dagen,
      dagen_open,
      urgentie,
      actie,
      reden,
      referentie: String(b.referentie || ''),
    };
  });

  // opvolgen eerst (bijna verlopen bovenaan), opruimen onderaan
  const prio = (i: OpvolgItem) => (i.actie === 'opruimen' ? 9 : ({ bijna_verlopen: 0, verlopen: 1, open: 2 })[i.urgentie]);
  items.sort((a, b) => (prio(a) - prio(b)) || (b.waarde - a.waarde));

  const opvolgItems = items.filter((i) => i.actie === 'opvolgen');
  const terugwinbaar = Math.round(opvolgItems.reduce((s, i) => s + i.waarde, 0) * 100) / 100;
  return { items, terugwinbaar, aantal: items.length, opruimen: items.filter((i) => i.actie === 'opruimen').length, al_gewonnen: alGewonnen };
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

/** Ruimt een dode offerte op: zet 'm op gearchiveerd zodat 'ie uit de jacht verdwijnt. */
export async function archiveerBoeking(boekingId: number): Promise<void> {
  await directus.request(updateItem('Boekingen', boekingId, { status: 'gearchiveerd' }));
  logger.info(`Boeking ${boekingId} opgeruimd (gearchiveerd)`);
}
