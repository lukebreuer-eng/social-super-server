/**
 * Bode: de communicatie-agent, nu een echte redenerende agent op de runtime.
 *
 * Bode krijgt een binnenkomende mail, snapt zelf de bedoeling (boeking, vraag,
 * klacht, leverancier) en handelt met zijn tools: concept-antwoord in de mailbox,
 * een event aanmaken (en dat wekt Aanjager voor een campagne), of escaleren bij
 * twijfel. Verstuurt nooit zelf; alles gaat als concept of alert.
 */

import { runAgent, ToolDef, AgentRunResult } from './runtime';
import { logger } from '../utils/logger';

export interface InkomendeMail {
  van: string;          // afzender e-mail
  vanNaam?: string;
  onderwerp: string;
  tekst: string;
  messageId?: string;
  datum?: string;
}

const tools: ToolDef[] = [
  {
    name: 'lees_klantgeschiedenis',
    description: 'Haal eerdere mail en het profiel van dit e-mailadres op, zodat je weet of het een terugkerende klant is en wat ze eerder deden.',
    input_schema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
    run: async (input, ctx) => {
      try {
        const m = await import('./mail-archief');
        const profiel = await (m as any).getKlantProfiel?.(ctx.bedrijfId, input.email);
        const context = await (m as any).getMailContext?.(ctx.bedrijfId, input.email, 8);
        return { profiel: profiel || null, recente_mail: context || 'geen historie' };
      } catch {
        return { profiel: null, recente_mail: 'mailarchief nog niet beschikbaar' };
      }
    },
  },
  {
    name: 'concept_antwoord',
    description: 'Zet een concept-antwoord klaar in de mailbox (map Concepten), gericht aan de afzender. Gebruik dit voor vragen, offerteaanvragen en bevestigingen. Het wordt NIET verzonden, jij/de eigenaar verstuurt zelf.',
    input_schema: { type: 'object', properties: { naar: { type: 'string' }, onderwerp: { type: 'string' }, body: { type: 'string' } }, required: ['naar', 'onderwerp', 'body'] },
    run: async (input) => {
      const { getIjsSmtpConfig, buildRfc822 } = await import('../email/smtp-sender');
      const { getIjsImapConfig, appendToDrafts } = await import('../email/imap-client');
      const smtp = getIjsSmtpConfig();
      const imap = getIjsImapConfig();
      if (!smtp || !imap) return { ok: false, reden: 'mailkoppeling niet geconfigureerd' };
      const crypto = await import('crypto');
      const raw = await buildRfc822(smtp, { to: String(input.naar || ''), subject: String(input.onderwerp || ''), textBody: String(input.body || '') }, `${crypto.randomUUID()}@ijsuitdepolder.nl`);
      const mailbox = await appendToDrafts(imap, raw);
      return { ok: !!mailbox, mailbox };
    },
  },
  {
    name: 'maak_event',
    description: 'Maak een event/boeking aan in de agenda als de mail over een concrete boeking of aanvraag op een datum gaat. Dit wekt Aanjager om een campagne voor te bereiden. Alleen doen bij een duidelijke datum/locatie.',
    input_schema: { type: 'object', properties: { titel: { type: 'string' }, event_datum: { type: 'string', description: 'YYYY-MM-DD' }, locatie: { type: 'string' }, event_type: { type: 'string', description: 'ijskraam/ijsbus/ijsscooter/gelatobar' }, notitie: { type: 'string' } }, required: ['titel', 'event_datum'] },
    run: async (input, ctx) => {
      const { voegEventToe } = await import('./aanjager');
      const ev = await voegEventToe(ctx.bedrijfId, input);
      await ctx.log({ actie: 'maak_event', beslissing: `Event "${input.titel}" op ${input.event_datum} aangemaakt`, status: 'gedaan', resultaat_id: ev.id });
      return { ok: true, eventId: ev.id, hint: 'Aanjager kan hier een campagne van maken' };
    },
  },
];

const BODE_DOEL = `Je bent de communicatie-agent van IJs uit de Polder (ambachtelijke ijscatering, Zeewolde).
Je leest één binnenkomende mail en handelt 'm af:
- Offerteaanvraag of vraag: zet een warm, menselijk concept-antwoord klaar (concept_antwoord). Eerst lees_klantgeschiedenis om de klant te kennen.
- Concrete boeking met datum en locatie: maak_event (Aanjager pakt de campagne op). Zet ook een bevestigend concept-antwoord klaar.
- Klacht, geld-/juridische kwestie, of iets onduidelijks of gevoeligs: escaleer, handel het niet zelf af.
- Spam/nieuwsbrief/leverancier zonder actie: gewoon 'klaar' zonder iets te doen.
Schrijf in het Nederlands, warm en persoonlijk, GEEN koppelstreepjes of em-dashes. Verzin geen feiten (prijzen, beschikbaarheid) die je niet zeker weet; bij twijfel escaleer of houd het algemeen. Verstuur nooit zelf.`;

/** Laat Bode één binnenkomende mail verwerken. */
export async function bodeVerwerkMail(bedrijfId: number, mail: InkomendeMail): Promise<AgentRunResult> {
  const invoer = `Nieuwe binnenkomende mail:
Van: ${mail.vanNaam || ''} <${mail.van}>
Onderwerp: ${mail.onderwerp}
Datum: ${mail.datum || ''}

${mail.tekst.slice(0, 4000)}

Handel deze mail af volgens je rol. Gebruik concept_antwoord met "naar" = ${mail.van}.`;
  logger.info(`Bode verwerkt mail van ${mail.van}: "${mail.onderwerp}"`);
  const { getKennisbankContext } = await import('./kennisbank');
  const doel = BODE_DOEL + (await getKennisbankContext(bedrijfId));
  return runAgent({ naam: 'Mail', doel, tools, maxStappen: 6 }, { bedrijfId, gebeurtenis: `Mail: ${mail.onderwerp}`.slice(0, 120), invoer });
}
