/**
 * Belmotor: één wachtrij voor alle uitgaande gesprekken.
 *
 * Niet drie losse bots, maar één motor met verschillende soorten opdrachten:
 * personeel inplannen, een terugbelverzoek afhandelen, een lead nabellen, of een
 * sales-briefing voorlezen. Het verschil met een klassieke outbound dialer is dat
 * het script hier per gesprek wordt samengesteld uit actuele data — een dialer
 * speelt een vast bandje af, deze weet wat de laatste factuur was.
 *
 * De telefonie komt er los overheen (Asterisk als SIP-toestel op de MiVoice
 * Business). Zolang die er niet is, is dit gewoon een afbellijst.
 */

import { directus } from '../config/directus';
import { readItems, createItem, updateItem } from '@directus/sdk';
import { logger } from '../utils/logger';

export type BelSoort = 'personeel' | 'terugbel' | 'lead' | 'briefing';

export interface Belopdracht {
  id?: number;
  bedrijf: number;
  soort: BelSoort;
  naam: string | null;
  telefoon: string;
  script: string;
  toetsen: Record<string, string> | null;
  bron_id?: number | null;
}

/** Nederlands telefoonnummer naar E.164, zodat de centrale er raad mee weet. */
export function normaliseerNummer(nummer: string): string | null {
  const cijfers = String(nummer || '').replace(/[^\d+]/g, '');
  if (!cijfers) return null;
  if (cijfers.startsWith('+')) return cijfers;
  if (cijfers.startsWith('00')) return `+${cijfers.slice(2)}`;
  if (cijfers.startsWith('06') || cijfers.startsWith('0')) return `+31${cijfers.slice(1)}`;
  return `+${cijfers}`;
}

/** Zet een opdracht in de wachtrij, tenzij dezelfde al openstaat. */
export async function planBelopdracht(o: Belopdracht): Promise<number | null> {
  const nummer = normaliseerNummer(o.telefoon);
  if (!nummer) { logger.warn(`Belopdracht zonder bruikbaar nummer overgeslagen (${o.naam})`); return null; }

  const open = (await directus.request(readItems('Belopdrachten', {
    filter: { bedrijf: { _eq: o.bedrijf }, telefoon: { _eq: nummer }, status: { _eq: 'wacht' } } as never,
    limit: -1, fields: ['id', 'soort', 'bron_id'] as never,
  }))) as Array<{ id: number; soort?: string; bron_id?: number }>;
  const dubbel = open.find((b) => b.soort === o.soort && Number(b.bron_id || 0) === Number(o.bron_id || 0));
  if (dubbel) return dubbel.id;

  const rij = (await directus.request(createItem('Belopdrachten', {
    bedrijf: o.bedrijf, soort: o.soort, status: 'wacht', naam: o.naam, telefoon: nummer,
    script: o.script, toetsen: o.toetsen, bron_id: o.bron_id ?? null,
    gepland_op: new Date().toISOString(), pogingen: 0,
  } as never))) as { id: number };

  logger.info(`Belopdracht ${rij.id} in de wachtrij: ${o.soort} naar ${o.naam || nummer}`);
  return rij.id;
}

/** Wat staat er te bellen? Dit is de lijst die de belbot afwerkt. */
export async function wachtrij(bedrijfId?: number): Promise<any[]> {
  const filter: Record<string, unknown> = { status: { _eq: 'wacht' } };
  if (bedrijfId) filter.bedrijf = { _eq: bedrijfId };
  return (await directus.request(readItems('Belopdrachten', {
    filter: filter as never, limit: -1, sort: ['gepland_op'],
  }))) as any[];
}

/** Uitkomst van een gesprek vastleggen. */
export async function verwerkUitkomst(id: number, uitkomst: {
  status: 'gebeld' | 'geen_gehoor' | 'afgebroken'; antwoord?: string; notitie?: string;
}): Promise<void> {
  const rijen = (await directus.request(readItems('Belopdrachten', {
    filter: { id: { _eq: id } } as never, limit: 1,
  }))) as Array<Record<string, unknown>>;
  const opdracht = rijen[0];
  if (!opdracht) return;

  await directus.request(updateItem('Belopdrachten', id, {
    status: uitkomst.status,
    antwoord: uitkomst.antwoord || null,
    notitie: uitkomst.notitie || null,
    gebeld_op: new Date().toISOString(),
    pogingen: (Number(opdracht.pogingen) || 0) + 1,
  } as never));

  // Een antwoord waar een mens iets mee moet, wordt een taak.
  const toetsen = (opdracht.toetsen || {}) as Record<string, string>;
  const betekenis = uitkomst.antwoord ? toetsen[uitkomst.antwoord] : null;
  if (betekenis && uitkomst.status === 'gebeld') {
    await directus.request(createItem('Tasks', {
      title: `${opdracht.naam || opdracht.telefoon}: ${betekenis}`,
      description: `Uitkomst van een uitgaand gesprek (${opdracht.soort}).\n\n`
        + `Antwoord: toets ${uitkomst.antwoord} = ${betekenis}\n`
        + `${uitkomst.notitie || ''}\n\nOpdracht #${id}`,
      bedrijf: Number(opdracht.bedrijf), status: 'open', priority: 'normal',
      category: opdracht.soort === 'personeel' ? 'planning' : 'sales', assigned_to: 'Luke',
    } as never));
  }
  logger.info(`Belopdracht ${id}: ${uitkomst.status}${betekenis ? ` (${betekenis})` : ''}`);
}

/** Terugbelverzoeken en nieuwe leads automatisch in de wachtrij zetten. */
export async function vulWachtrijUitLeads(bedrijfId: number): Promise<{ toegevoegd: number }> {
  const leads = (await directus.request(readItems('Leads', {
    filter: { bedrijf: { _eq: bedrijfId }, status: { _eq: 'new' } } as never, limit: -1,
    fields: ['id', 'naam', 'telefoon', 'bericht', 'bron', 'notities'] as never,
  }))) as Array<Record<string, unknown>>;

  let toegevoegd = 0;
  for (const l of leads) {
    if (!l.telefoon) continue;
    const naam = String(l.naam || '').startsWith('Onbekend') ? null : String(l.naam || '');
    const script = `Hoi${naam ? ` ${naam.split(' ')[0]}` : ''}, met IJs uit de Polder. `
      + `Je hebt contact met ons opgenomen over ijscatering. `
      + `Ik wil even met je afstemmen wat je precies zoekt. `
      + `Toets 1 als het nu uitkomt, toets 2 als we je later moeten bellen.`;
    const id = await planBelopdracht({
      bedrijf: bedrijfId, soort: 'lead', naam, telefoon: String(l.telefoon),
      script, toetsen: { '1': 'wil nu praten', '2': 'liever later terugbellen' },
      bron_id: Number(l.id),
    });
    if (id) toegevoegd++;
  }
  logger.info(`Belwachtrij bedrijf ${bedrijfId}: ${toegevoegd} leads toegevoegd`);
  return { toegevoegd };
}
