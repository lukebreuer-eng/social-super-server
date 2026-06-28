/**
 * Mailarchief + klantprofielen.
 *
 * Doel: een volledig, doorzoekbaar archief van alle inkomende en uitgaande
 * mail per bedrijf, zodat AI-agenten een klant "kennen" (topprofiel) voordat
 * ze een antwoord opstellen.
 *
 * - backfillMailArchief(): leest INBOX + Verzonden-map via IMAP (read-only),
 *   parset met mailparser en schrijft naar de Directus-collectie Mail_Archief.
 *   Dedupliceert op message_id, kan in batches via maxPerMap.
 * - getKlantProfiel(): aggregeert alle mail van/naar een e-mailadres.
 * - getMailContext(): recentste berichten als context-string voor een agent.
 * - zoekMail(): simpele tekstzoek over onderwerp + tekst.
 *
 * LET OP: dit leest alleen mail. Er wordt NIETS verstuurd en er worden geen
 * Seen-flags gezet (Outlook blijft ongelezen mail ongelezen tonen).
 */

import { ImapFlow, FetchMessageObject } from 'imapflow';
import { simpleParser, ParsedMail } from 'mailparser';
import { directus } from '../config/directus';
import { createItem, readItems } from '@directus/sdk';
import { getIjsImapConfig, InboxAccountConfig } from '../email/imap-client';
import { logger } from '../utils/logger';

// De collectie Mail_Archief staat (nog) niet in de Schema-interface van
// config/directus.ts. De hoofdthread voegt daar
//   Mail_Archief: Record<string, unknown>[];
// aan toe (zie wiring-spec). Tot die tijd casten we de naam zodat dit bestand
// los typechecked zonder config/directus.ts te bewerken.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const COL = 'Mail_Archief' as any;

/** Maximaal aantal tekens dat we van de platte tekst bewaren. */
const MAX_TEKST = 4000;

/** Eén rij in de Mail_Archief-collectie. */
export interface MailArchiefRecord {
  id?: number;
  bedrijf: number;
  richting: 'in' | 'uit';
  contact_email: string;
  van: string;
  naar: string;
  onderwerp: string;
  datum: string; // ISO timestamp
  message_id: string;
  tekst: string;
  map: string;
}

/**
 * Bepaal de IMAP-config voor een bedrijf. Op dit moment is alleen IJs uit de
 * Polder (bedrijf 7) gekoppeld. Andere bedrijven kunnen hier later bij.
 */
function getImapConfigVoorBedrijf(bedrijfId: number): InboxAccountConfig | null {
  if (bedrijfId === 7) return getIjsImapConfig();
  return null;
}

/** Maak een imapflow-client (zelfde patroon als email/imap-client.ts). */
function buildClient(cfg: InboxAccountConfig): ImapFlow {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
  });
}

/** Kort een string netjes in op een maximum aantal tekens. */
function knip(s: string, max: number): string {
  if (!s) return '';
  const schoon = s.replace(/\r\n/g, '\n').trim();
  return schoon.length > max ? schoon.slice(0, max) : schoon;
}

/** Haal het eerste e-mailadres uit een lijst, of lege string. */
function eersteAdres(adressen: string[]): string {
  return adressen.find(Boolean) || '';
}

/**
 * Parse een opgehaald IMAP-bericht naar een Mail_Archief-rij.
 * richting bepaalt of het contact de afzender (in) of de ontvanger (uit) is.
 */
async function parseNaarRecord(
  msg: FetchMessageObject,
  bedrijfId: number,
  richting: 'in' | 'uit',
  mapNaam: string,
): Promise<MailArchiefRecord | null> {
  if (!msg.source) return null;
  const parsed: ParsedMail = await simpleParser(msg.source);

  const fromAddr = parsed.from?.value?.[0];
  const vanEmail = (fromAddr?.address || '').toLowerCase();
  const vanNaam = fromAddr?.name || '';

  const toArr = Array.isArray(parsed.to)
    ? parsed.to.flatMap((a) => a.value || [])
    : parsed.to?.value || [];
  const naarAdressen = toArr.map((a) => (a.address || '').toLowerCase()).filter(Boolean);

  const messageId = (parsed.messageId || '').replace(/^<|>$/g, '');
  if (!messageId) return null; // zonder message_id kunnen we niet dedupliceren

  // Bij inkomende mail is het contact de afzender, bij uitgaande de ontvanger.
  const contact = richting === 'in' ? vanEmail : eersteAdres(naarAdressen);

  return {
    bedrijf: bedrijfId,
    richting,
    contact_email: contact,
    van: vanNaam ? `${vanNaam} <${vanEmail}>` : vanEmail,
    naar: naarAdressen.join(', '),
    onderwerp: knip(parsed.subject || '(geen onderwerp)', 500),
    datum: (parsed.date || new Date()).toISOString(),
    message_id: knip(messageId, 255),
    tekst: knip(parsed.text || parsed.subject || '', MAX_TEKST),
    map: mapNaam,
  };
}

/** Haal alle al gearchiveerde message_ids van een bedrijf op (voor dedup). */
async function bestaandeMessageIds(bedrijfId: number): Promise<Set<string>> {
  const set = new Set<string>();
  const pageSize = 500;
  let page = 1;
  // Paginatie zodat we ook grote archieven volledig dekken.
  for (;;) {
    const rows = (await directus.request(
      readItems(COL, {
        filter: { bedrijf: { _eq: bedrijfId } },
        fields: ['message_id'],
        limit: pageSize,
        page,
      }),
    )) as unknown as Array<{ message_id: string }>;
    for (const r of rows) if (r.message_id) set.add(r.message_id);
    if (rows.length < pageSize) break;
    page += 1;
  }
  return set;
}

/**
 * Open de juiste map en archiveer de recentste berichten.
 * Probeert meerdere mapnamen (Sent/Verzonden varianten) en geeft het aantal
 * nieuw opgeslagen berichten terug.
 */
async function backfillMap(
  client: ImapFlow,
  bedrijfId: number,
  richting: 'in' | 'uit',
  mapKandidaten: string[],
  reedsAanwezig: Set<string>,
  maxPerMap: number,
): Promise<{ map: string | null; opgeslagen: number; bekeken: number }> {
  // Vind de eerste map die we kunnen openen.
  let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>> | null = null;
  let gebruikteMap: string | null = null;
  for (const naam of mapKandidaten) {
    try {
      lock = await client.getMailboxLock(naam);
      gebruikteMap = naam;
      break;
    } catch {
      // probeer de volgende kandidaat
    }
  }
  if (!lock || !gebruikteMap) {
    logger.warn(`Mail_Archief: geen van de mappen [${mapKandidaten.join(', ')}] kon worden geopend`);
    return { map: null, opgeslagen: 0, bekeken: 0 };
  }

  let opgeslagen = 0;
  let bekeken = 0;
  try {
    const totaal = (client.mailbox && typeof client.mailbox === 'object' ? client.mailbox.exists : 0) || 0;
    if (totaal === 0) {
      logger.info(`Mail_Archief: map "${gebruikteMap}" is leeg`);
      return { map: gebruikteMap, opgeslagen: 0, bekeken: 0 };
    }

    // Pak de recentste N berichten op sequence-nummer (hoogste = nieuwste).
    const vanaf = maxPerMap > 0 ? Math.max(1, totaal - maxPerMap + 1) : 1;
    const range = `${vanaf}:${totaal}`;

    for await (const msg of client.fetch(range, { source: true, uid: true })) {
      bekeken += 1;
      let record: MailArchiefRecord | null = null;
      try {
        record = await parseNaarRecord(msg, bedrijfId, richting, gebruikteMap);
      } catch (e) {
        logger.warn(`Mail_Archief: parse-fout in "${gebruikteMap}": ${(e as Error).message}`);
        continue;
      }
      if (!record) continue;
      if (reedsAanwezig.has(record.message_id)) continue; // dedup

      try {
        await directus.request(createItem(COL, record as unknown as Record<string, unknown>));
        reedsAanwezig.add(record.message_id);
        opgeslagen += 1;
      } catch (e) {
        logger.warn(`Mail_Archief: opslaan faalde voor "${record.onderwerp}": ${(e as Error).message}`);
      }
    }
  } finally {
    lock.release();
  }

  logger.info(`Mail_Archief: map "${gebruikteMap}" — ${bekeken} bekeken, ${opgeslagen} nieuw opgeslagen`);
  return { map: gebruikteMap, opgeslagen, bekeken };
}

/**
 * Backfill: archiveer mail uit INBOX (inkomend) en de Verzonden-map (uitgaand).
 * Idempotent dankzij dedup op message_id. Gebruik maxPerMap om een testrun klein
 * te houden (bijv. 30). Lezen is read-only, er wordt niets verstuurd.
 */
export async function backfillMailArchief(
  bedrijfId: number,
  opts?: { maxPerMap?: number },
): Promise<{ inbox: number; sent: number; totaal: number }> {
  const cfg = getImapConfigVoorBedrijf(bedrijfId);
  if (!cfg) {
    throw new Error(`Geen IMAP-config voor bedrijf ${bedrijfId} (alleen IJs/bedrijf 7 is gekoppeld)`);
  }
  const maxPerMap = opts?.maxPerMap ?? 0; // 0 = alles

  logger.info(`Mail_Archief backfill gestart voor bedrijf ${bedrijfId} (maxPerMap=${maxPerMap || 'alles'})`);

  const reedsAanwezig = await bestaandeMessageIds(bedrijfId);
  logger.info(`Mail_Archief: ${reedsAanwezig.size} berichten al gearchiveerd`);

  const client = buildClient(cfg);
  await client.connect();

  let inbox = 0;
  let sent = 0;
  try {
    const inboxRes = await backfillMap(
      client,
      bedrijfId,
      'in',
      [cfg.inboxMailbox, 'INBOX'],
      reedsAanwezig,
      maxPerMap,
    );
    inbox = inboxRes.opgeslagen;

    const sentRes = await backfillMap(
      client,
      bedrijfId,
      'uit',
      [cfg.sentMailbox, 'Sent', 'Sent Items', 'Verzonden items', 'Verzonden', 'INBOX.Sent'],
      reedsAanwezig,
      maxPerMap,
    );
    sent = sentRes.opgeslagen;
  } finally {
    await client.logout().catch(() => undefined);
  }

  const totaal = inbox + sent;
  logger.info(`Mail_Archief backfill klaar: ${inbox} inkomend + ${sent} uitgaand = ${totaal} nieuw`);
  return { inbox, sent, totaal };
}

/** Profiel van een klant op basis van het volledige mailarchief. */
export interface KlantProfiel {
  email: string;
  bedrijf: number;
  aantal_berichten: number;
  aantal_inkomend: number;
  aantal_uitgaand: number;
  eerste_contact: string | null;
  laatste_contact: string | null;
  onderwerpen: string[];
  samenvatting: string;
}

/**
 * Aggregeer alle mail van/naar een e-mailadres tot een klantprofiel.
 * Geen AI nodig: puur tellen en samenvatten zodat een agent de klant "kent".
 */
export async function getKlantProfiel(bedrijfId: number, email: string): Promise<KlantProfiel> {
  const adres = email.toLowerCase().trim();
  const rows = (await directus.request(
    readItems(COL, {
      filter: { bedrijf: { _eq: bedrijfId }, contact_email: { _eq: adres } },
      fields: ['richting', 'onderwerp', 'datum'],
      sort: ['datum'],
      limit: -1,
    }),
  )) as unknown as Array<{ richting: string; onderwerp: string; datum: string }>;

  const aantalIn = rows.filter((r) => r.richting === 'in').length;
  const aantalUit = rows.filter((r) => r.richting === 'uit').length;
  const eerste = rows.length ? rows[0].datum : null;
  const laatste = rows.length ? rows[rows.length - 1].datum : null;

  // Unieke onderwerpen, schoongemaakt van Re:/Fwd:-voorvoegsels.
  const onderwerpen = Array.from(
    new Set(
      rows
        .map((r) => (r.onderwerp || '').replace(/^((re|fwd|fw|aw|antw)\s*:\s*)+/i, '').trim())
        .filter(Boolean),
    ),
  );

  const samenvatting =
    rows.length === 0
      ? `Nog geen mailcontact bekend met ${adres}.`
      : `${rows.length} berichten met ${adres} (${aantalIn} ontvangen, ${aantalUit} verstuurd). ` +
        `Eerste contact ${eerste ? eerste.slice(0, 10) : 'onbekend'}, ` +
        `laatste contact ${laatste ? laatste.slice(0, 10) : 'onbekend'}. ` +
        `Onderwerpen: ${onderwerpen.slice(0, 8).join('; ') || 'geen'}.`;

  return {
    email: adres,
    bedrijf: bedrijfId,
    aantal_berichten: rows.length,
    aantal_inkomend: aantalIn,
    aantal_uitgaand: aantalUit,
    eerste_contact: eerste,
    laatste_contact: laatste,
    onderwerpen,
    samenvatting,
  };
}

/**
 * Geef de recentste berichten voor een e-mailadres terug als context-string,
 * klaar om in een agent-prompt te plakken.
 */
export async function getMailContext(bedrijfId: number, email: string, limit = 10): Promise<string> {
  const adres = email.toLowerCase().trim();
  const rows = (await directus.request(
    readItems(COL, {
      filter: { bedrijf: { _eq: bedrijfId }, contact_email: { _eq: adres } },
      fields: ['richting', 'van', 'onderwerp', 'datum', 'tekst'],
      sort: ['-datum'],
      limit,
    }),
  )) as unknown as Array<{ richting: string; van: string; onderwerp: string; datum: string; tekst: string }>;

  if (rows.length === 0) return `Geen eerdere mail gevonden met ${adres}.`;

  // Oudste eerst tonen leest prettiger als gesprekslijn.
  const blokken = rows.reverse().map((r) => {
    const wie = r.richting === 'in' ? 'KLANT' : 'WIJ';
    const datum = (r.datum || '').slice(0, 10);
    const tekst = knip(r.tekst || '', 800);
    return `[${datum}] ${wie} — ${r.onderwerp}\n${tekst}`;
  });

  return `Mailgeschiedenis met ${adres} (recentste ${rows.length}):\n\n${blokken.join('\n\n---\n\n')}`;
}

/** Eén zoekresultaat uit het mailarchief. */
export interface MailZoekResultaat {
  id: number;
  richting: string;
  contact_email: string;
  onderwerp: string;
  datum: string;
  fragment: string;
}

/**
 * Simpele tekstzoek over onderwerp en tekst van het archief van een bedrijf.
 */
export async function zoekMail(
  bedrijfId: number,
  query: string,
  limit = 10,
): Promise<MailZoekResultaat[]> {
  const q = query.trim();
  if (!q) return [];

  const rows = (await directus.request(
    readItems(COL, {
      filter: {
        bedrijf: { _eq: bedrijfId },
        _or: [
          { onderwerp: { _icontains: q } },
          { tekst: { _icontains: q } },
        ],
      },
      fields: ['id', 'richting', 'contact_email', 'onderwerp', 'datum', 'tekst'],
      sort: ['-datum'],
      limit,
    }),
  )) as unknown as Array<{
    id: number;
    richting: string;
    contact_email: string;
    onderwerp: string;
    datum: string;
    tekst: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    richting: r.richting,
    contact_email: r.contact_email,
    onderwerp: r.onderwerp,
    datum: r.datum,
    fragment: knip(r.tekst || '', 300),
  }));
}
