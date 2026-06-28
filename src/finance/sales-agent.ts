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

  // Intelligentie: een offerte van een klant die al gefactureerd of als boeking
  // gewonnen is, NIET najagen. Match op het kernwoord van de naam (bv "postillion")
  // zodat naamvarianten ook gevangen worden; stopwoorden voorkomen vals-positieven.
  const STOP = new Set(['bv', 'group', 'holding', 'hotel', 'hotels', 'stichting', 'gemeente', 'nederland', 'catering', 'transport', 'logistics', 'zeewolde', 'almere', 'dronten', 'amersfoort', 'harderwijk', 'lelystad', 'festivals', 'zorg', 'vereniging']);
  const norm = (s: any) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const kernwoord = (s: any) => norm(s).split(' ').find((t) => t.length >= 5 && !STOP.has(t)) || '';
  const convertedNorm = new Set<string>();
  const convertedKern = new Set<string>();
  for (const x of [...facturen, ...gewonnen]) {
    const nm = norm(x.contact_naam); if (nm) convertedNorm.add(nm);
    const k = kernwoord(x.contact_naam); if (k) convertedKern.add(k);
  }
  const isGeconverteerd = (naam: string) => {
    const n = norm(naam);
    if (!n) return false;
    if (convertedNorm.has(n)) return true;
    const k = kernwoord(naam);
    return !!k && convertedKern.has(k);
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

/**
 * Jager x Bode: draft de opvolg-mail EN zet 'm als concept in de echte mailbox
 * (Concepten-map), zodat je niks hoeft te kopiëren. Valt terug op alleen-tekst
 * als de mailkoppeling niet beschikbaar is.
 */
export async function draftOpvolgNaarMailbox(boekingId: number): Promise<{ onderwerp: string; body: string; mailbox: string | null }> {
  const draft = await draftOpvolgMail(boekingId);
  const b = (await directus.request(readItem('Boekingen', boekingId))) as any;
  const to = String(b?.contact_email || '');

  try {
    const { getIjsSmtpConfig, buildRfc822 } = await import('../email/smtp-sender');
    const { getIjsImapConfig, appendToDrafts } = await import('../email/imap-client');
    const smtp = getIjsSmtpConfig();
    const imap = getIjsImapConfig();
    if (!smtp || !imap) {
      logger.warn('Mailkoppeling niet geconfigureerd, opvolg-mail blijft alleen-tekst');
      return { ...draft, mailbox: null };
    }
    const crypto = await import('crypto');
    const messageId = `${crypto.randomUUID()}@ijsuitdepolder.nl`;
    const raw = await buildRfc822(smtp, { to, subject: draft.onderwerp, textBody: draft.body }, messageId);
    const mailbox = await appendToDrafts(imap, raw);
    return { ...draft, mailbox };
  } catch (e) {
    logger.warn(`Concept in mailbox plaatsen faalde: ${(e as Error).message}`);
    return { ...draft, mailbox: null };
  }
}

/** Ruimt een dode offerte op: zet 'm op gearchiveerd zodat 'ie uit de jacht verdwijnt. */
export async function archiveerBoeking(boekingId: number): Promise<void> {
  await directus.request(updateItem('Boekingen', boekingId, { status: 'gearchiveerd' }));
  logger.info(`Boeking ${boekingId} opgeruimd (gearchiveerd)`);
}
