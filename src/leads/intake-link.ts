/**
 * Intake-link: de gegevens die je niet aan de telefoon moet uitvragen.
 *
 * Een e-mailadres of postcode laten spellen aan een voice bot gaat mis, hoe goed
 * het model ook is. Eén letter fout en je offerte komt nergens aan. Daarom vraagt
 * Bolletje alleen wat hij goed kan verstaan (datum, aantal, wagen, plaats) en
 * gaat de rest via een linkje naar het nummer dat toch al binnenkomt via
 * nummerherkenning. De klant vult het zelf in, foutloos.
 *
 * Het versturen zelf is bewust losgekoppeld: zolang er geen sms-provider
 * gekoppeld is, levert dit gewoon een link plus een kant-en-klaar bericht op dat
 * met de hand te appen is.
 */

import { randomBytes } from 'crypto';
import { directus } from '../config/directus';
import { readItems, createItem, updateItem } from '@directus/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const BASIS = 'https://api.ipaudio.nl/intake';

export interface IntakeLink {
  token: string;
  url: string;
  bericht: string;
  verstuurd_via: 'sms' | 'whatsapp' | 'handmatig';
}

/** Maak een link waarmee de klant zijn eigen gegevens aanvult. */
export async function maakIntakeLink(leadId: number, kanaal: 'sms' | 'whatsapp' = 'sms'): Promise<IntakeLink> {
  const leads = (await directus.request(readItems('Leads', {
    filter: { id: { _eq: leadId } } as never, limit: 1,
  }))) as Array<Record<string, unknown>>;
  const lead = leads[0];
  if (!lead) throw new Error(`lead ${leadId} bestaat niet`);

  const token = randomBytes(16).toString('base64url');
  await directus.request(updateItem('Leads', leadId, {
    externe_id: String(lead.externe_id || ''),
    bron_url: `${BASIS}/${token}`,
    notities: `${lead.notities || ''}\nIntake-link aangemaakt op ${new Date().toLocaleDateString('nl-NL')}.`.trim(),
  } as never));

  const url = `${BASIS}/${token}`;
  const voornaam = String(lead.naam || '').split(' ')[0];
  const bericht = voornaam && !voornaam.startsWith('Onbekend')
    ? `Hoi ${voornaam}! Bedankt voor je telefoontje bij IJs uit de Polder. `
      + `Vul hier even je gegevens aan, dan sturen we je de offerte: ${url}`
    : `Bedankt voor je telefoontje bij IJs uit de Polder! `
      + `Vul hier even je gegevens aan, dan sturen we je de offerte: ${url}`;

  logger.info(`Intake-link voor lead ${leadId}: ${url}`);
  return { token, url, bericht, verstuurd_via: env.SMS_PROVIDER ? kanaal : 'handmatig' };
}

/** De gegevens die de klant zelf invult, terugzetten op de lead. */
export async function verwerkIntake(token: string, gegevens: {
  email?: string; naam?: string; telefoon?: string; adres?: string; plaats?: string; opmerking?: string;
}): Promise<{ ok: boolean; lead_id?: number }> {
  const leads = (await directus.request(readItems('Leads', {
    filter: { bron_url: { _eq: `${BASIS}/${token}` } } as never, limit: 1,
  }))) as Array<Record<string, unknown>>;
  const lead = leads[0];
  if (!lead) return { ok: false };

  const extra = [
    gegevens.adres ? `Adres: ${gegevens.adres}` : null,
    gegevens.plaats ? `Plaats: ${gegevens.plaats}` : null,
    gegevens.opmerking ? `Opmerking van de klant: ${gegevens.opmerking}` : null,
  ].filter(Boolean).join('\n');

  await directus.request(updateItem('Leads', Number(lead.id), {
    email: gegevens.email || lead.email || null,
    naam: gegevens.naam || lead.naam,
    telefoon: gegevens.telefoon || lead.telefoon || null,
    notities: `${lead.notities || ''}\n${extra}`.trim(),
    last_interaction: new Date().toISOString(),
    lead_temperature: 'hot',
  } as never));

  // Nu er een e-mailadres is, kan de offerte de deur uit.
  await directus.request(createItem('Tasks', {
    title: `Gegevens binnen van ${gegevens.naam || lead.naam} — offerte kan eruit`,
    description: `De klant heeft zelf zijn gegevens ingevuld na het telefoongesprek.\n\n`
      + `E-mail: ${gegevens.email || 'niet ingevuld'}\n${extra}\n\nLead #${lead.id}`,
    bedrijf: 7, status: 'open', priority: 'high', category: 'sales', assigned_to: 'Luke',
  } as never));

  logger.info(`Intake ingevuld voor lead ${lead.id} (${gegevens.email || 'geen mail'})`);
  return { ok: true, lead_id: Number(lead.id) };
}
