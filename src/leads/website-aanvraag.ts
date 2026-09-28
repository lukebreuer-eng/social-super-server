/**
 * De aanvraag vanaf de website afhandelen.
 *
 * Het boekingsformulier stuurde tot nu toe alleen door naar Moneybird. De klant
 * vulde alles in - wagen, datum, aantal, factuuradres - en hoorde vervolgens
 * niets. Geen bevestiging, geen "we hebben het ontvangen", en in het systeem
 * kwam de aanvraag ook niet terecht.
 *
 * Deze webhook vangt dat op: bevestiging naar de klant binnen enkele seconden,
 * de aanvraag als lead, een haalbaarheidscheck en een taak voor Luke.
 */

import axios from 'axios';
import { directus } from '../config/directus';
import { readItems, createItem } from '@directus/sdk';
import { sendEmail } from '../email/resend-client';
import { logger } from '../utils/logger';

const BEDRIJF = 7;

export interface WebsiteAanvraag {
  naam?: string; email?: string; telefoon?: string;
  wagen?: string; datum?: string; starttijd?: string; eindtijd?: string;
  aantal_personen?: string | number; bollen?: string | number;
  event_postcode?: string; bedrijfsnaam?: string;
  factuuradres?: string; factuur_postcode?: string; factuur_huisnummer?: string;
  bron?: string; opmerking?: string;
}

/**
 * Elementor stuurt zijn webhook in meerdere vormen, afhankelijk van versie en
 * instellingen: platte sleutels als form_fields[naam], een fields-object met
 * {value,title} per veld, of gewoon fields[naam]. Alledrie worden hier
 * uitgepakt, zodat een versie-update de aanvragen niet stilletjes laat vallen.
 */
export function normaliseerFormulier(body: Record<string, unknown>): WebsiteAanvraag {
  const plat: Record<string, string> = {};

  const zet = (sleutel: string, waarde: unknown) => {
    const naam = String(sleutel).replace(/^(form_)?fields\[/, '').replace(/\]$/, '').trim().toLowerCase();
    if (waarde == null || waarde === '') return;
    // Elementor kan per veld een object sturen met value en title.
    const v = typeof waarde === 'object' && waarde !== null && 'value' in (waarde as any)
      ? (waarde as any).value : waarde;
    if (v == null || v === '') return;
    plat[naam] = String(v);
    // Het label van het veld helpt herkennen wat het is, want Elementor gebruikt
    // vaak gegenereerde id's als field_77bbe8a.
    const titel = typeof waarde === 'object' && waarde !== null ? String((waarde as any).title || '') : '';
    if (titel) plat[`titel:${titel.toLowerCase()}`] = String(v);
  };

  for (const [k, v] of Object.entries(body || {})) {
    if (k === 'fields' && typeof v === 'object' && v !== null) {
      for (const [fk, fv] of Object.entries(v as Record<string, unknown>)) zet(fk, fv);
    } else {
      zet(k, v);
    }
  }

  // Op label zoeken als de veldnaam een gegenereerde id is.
  const opLabel = (...woorden: string[]): string | undefined => {
    for (const [k, v] of Object.entries(plat)) {
      if (!k.startsWith('titel:')) continue;
      const label = k.slice(6);
      if (woorden.some((w) => label.includes(w))) return v;
    }
    return undefined;
  };
  plat.wagen = plat.wagen || opLabel('wagen', 'middel', 'welke') || '';
  plat.aantal_personen = plat.aantal_personen || opLabel('personen', 'aantal gasten', 'hoeveel') || '';
  plat.bollen = plat.bollen || opLabel('bol') || '';
  plat.datum = plat.datum || opLabel('datum', 'wanneer') || '';
  plat.telefoon = plat.telefoon || opLabel('telefoon', 'mobiel', 'nummer') || '';
  // Elementor gebruikt soms veld-id's; de herkenbare namen hebben voorrang.
  return {
    naam: plat.name || plat.naam,
    email: plat.email,
    telefoon: plat.telefoon || plat.phone || plat.tel,
    wagen: plat.wagen || plat.middel,
    datum: plat.datum || plat.date || plat.event_datum,
    starttijd: plat.starttijd, eindtijd: plat.eindtijd,
    aantal_personen: plat.aantal_personen || plat.personen || plat.aantal,
    bollen: plat.bollen || plat.bolletjes,
    event_postcode: plat.event_postcode,
    bedrijfsnaam: plat.bedrijfsnaam,
    factuuradres: plat.factuuradres,
    factuur_postcode: plat.factuur_postcode,
    factuur_huisnummer: plat.factuur_huisnummer,
    bron: plat.bron,
    opmerking: plat.opmerking || plat.bericht || plat.message,
  };
}

function bevestigingHtml(a: WebsiteAanvraag): string {
  const regel = (label: string, waarde?: string | number | null) =>
    waarde ? `<tr><td style="padding:4px 14px 4px 0;color:#777">${label}</td><td style="padding:4px 0"><strong>${waarde}</strong></td></tr>` : '';
  const datum = a.datum
    ? new Date(a.datum).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  const voornaam = String(a.naam || '').split(' ')[0];

  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;color:#2b2b2b;line-height:1.55">
    <p style="font-size:17px">Hoi${voornaam ? ` ${voornaam}` : ''},</p>
    <p>Bedankt voor je aanvraag bij IJs uit de Polder. We hebben hem goed ontvangen.</p>
    <p><strong>Dit hebben we genoteerd:</strong></p>
    <table style="font-size:15px;border-collapse:collapse">
      ${regel('Wat', a.wagen)}
      ${regel('Wanneer', datum)}
      ${regel('Hoe laat', a.starttijd && a.eindtijd ? `${a.starttijd} tot ${a.eindtijd}` : a.starttijd)}
      ${regel('Aantal gasten', a.aantal_personen)}
      ${regel('Bolletjes per persoon', a.bollen)}
      ${regel('Locatie', a.event_postcode)}
    </table>
    <p style="margin-top:18px">We kijken of we die dag kunnen draaien en sturen je <strong>binnen één werkdag</strong> een offerte op maat.
    Klopt er iets niet, of wil je nog iets toevoegen? Antwoord gerust even op deze mail.</p>
    <p style="margin-top:22px">Tot snel! 🍦<br>
    <strong>Levi &amp; Luke</strong><br>
    <span style="color:#777;font-size:13px">IJs uit de Polder &middot; Zeewolde &middot; 088 040 5885</span></p>
  </div>`;
}

export interface AanvraagResultaat {
  ok: boolean; lead_id?: number; bevestiging_verstuurd: boolean; haalbaar?: boolean | null; redenen?: string[];
}

export async function verwerkWebsiteAanvraag(body: Record<string, unknown>): Promise<AanvraagResultaat> {
  const a = normaliseerFormulier(body);
  if (!a.email && !a.telefoon) {
    // Loggen wat er wél binnenkwam; zonder dat is een gewijzigd formulier niet
    // te achterhalen en verdwijnen aanvragen ongemerkt.
    logger.warn(`Website-aanvraag zonder mail of telefoon. Ontvangen sleutels: ${Object.keys(body || {}).join(', ').slice(0, 300)}`);
    return { ok: false, bevestiging_verstuurd: false };
  }

  const personen = Number(String(a.aantal_personen || '').replace(/\D/g, '')) || 0;
  const bollen = Number(String(a.bollen || '').replace(/\D/g, '')) || 2;

  // Kunnen we het draaien? Zelfde check als Bolletje gebruikt.
  let haalbaar: boolean | null = null;
  let redenen: string[] = [];
  if (a.datum && /^\d{4}-\d{2}-\d{2}/.test(a.datum)) {
    try {
      const boekingen = (await directus.request(readItems('Boekingen', {
        filter: { bedrijf: { _eq: BEDRIJF }, status: { _eq: 'gewonnen' } }, limit: -1,
        fields: ['event_datum', 'middel'],
      }))) as Array<{ event_datum?: string; middel?: string }>;
      const dag = a.datum.slice(0, 10);
      const zelfdeDag = boekingen.filter((b) => String(b.event_datum || '').slice(0, 10) === dag);
      if (zelfdeDag.some((b) => String(b.middel || '').toLowerCase() === String(a.wagen || '').toLowerCase())) {
        redenen.push(`de ${a.wagen} staat die dag al ergens anders`);
      }
      if (zelfdeDag.length >= 3) redenen.push(`er staan die dag al ${zelfdeDag.length} klussen`);
      haalbaar = redenen.length === 0;
    } catch { /* check overslaan is niet erg, de aanvraag telt */ }
  }

  const notities = [
    a.wagen ? `Middel: ${a.wagen}` : null,
    a.datum ? `Datum: ${a.datum}` : null,
    a.starttijd ? `Tijd: ${a.starttijd} - ${a.eindtijd || '?'}` : null,
    personen ? `${personen} personen x ${bollen} bollen` : null,
    a.event_postcode ? `Locatie: ${a.event_postcode}` : null,
    a.bedrijfsnaam ? `Bedrijf: ${a.bedrijfsnaam}` : null,
    [a.factuuradres, a.factuur_huisnummer, a.factuur_postcode].filter(Boolean).join(' ') || null,
    a.bron ? `Bron: ${a.bron}` : null,
  ].filter(Boolean).join('\n');

  const lead = (await directus.request(createItem('Leads', {
    bedrijf: BEDRIJF, bron: 'website', naam: a.naam || a.bedrijfsnaam || 'Onbekend',
    email: a.email || null, telefoon: a.telefoon || null, bedrijf_naam: a.bedrijfsnaam || null,
    bericht: `Boekingsaanvraag via de website: ${a.wagen || 'ijscatering'}${a.datum ? ` op ${a.datum}` : ''}.`,
    notities, status: 'new', lead_temperature: 'hot',
    first_interaction: new Date().toISOString(), last_interaction: new Date().toISOString(),
    interaction_count: 1, product_type: 'contact',
    product_details: { ...a, personen, bollen, haalbaar },
  } as never))) as { id: number };

  let verstuurd = false;
  if (a.email) {
    try {
      await sendEmail({
        to: a.email,
        subject: 'We hebben je aanvraag ontvangen 🍦',
        html: bevestigingHtml(a),
        from: 'IJs uit de Polder <info@ijsuitdepolder.nl>',
      });
      verstuurd = true;
    } catch (error) {
      logger.warn(`Bevestiging naar ${a.email} mislukt: ${(error as Error).message}`);
    }
  }

  await directus.request(createItem('Tasks', {
    title: haalbaar === false
      ? `LET OP: website-aanvraag die we mogelijk niet kunnen draaien — ${a.naam || a.email}`
      : `Offerte maken: ${a.naam || a.bedrijfsnaam || a.email} — ${a.wagen || 'ijscatering'}${a.datum ? ` (${a.datum})` : ''}`,
    description: `Aanvraag via het boekingsformulier op de website.\n\n${notities}\n\n`
      + `Contact: ${a.email || 'geen mail'} / ${a.telefoon || 'geen nummer'}\n`
      + (redenen.length ? `\nLet op:\n${redenen.map((r) => `- ${r}`).join('\n')}\n` : '')
      + `\nDe klant heeft ${verstuurd ? 'een bevestiging gekregen en verwacht binnen één werkdag een offerte' : 'GEEN bevestiging gekregen (geen mailadres)'}.\n\nLead #${lead.id}`,
    bedrijf: BEDRIJF, status: 'open', priority: 'high', category: 'sales', assigned_to: 'Luke',
  } as never));

  // Elementor kan maar één webhook aan, dus deze staat ervoor en geeft de
  // aanvraag door aan het bestaande script dat de offerte in Moneybird zet.
  // Faalt dat, dan is de aanvraag hier al vastgelegd en weet Luke het via de taak.
  try {
    await axios.post('https://ijsuitdepolder.nl/moneybird-webhook.php', body, {
      timeout: 20000, headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    logger.warn(`Doorsturen naar moneybird-webhook.php mislukt: ${(error as Error).message}`);
  }

  logger.info(`Website-aanvraag van ${a.naam || a.email}: lead ${lead.id}, bevestiging ${verstuurd ? 'verstuurd' : 'niet verstuurd'}, haalbaar=${haalbaar}`);
  return { ok: true, lead_id: lead.id, bevestiging_verstuurd: verstuurd, haalbaar, redenen };
}
