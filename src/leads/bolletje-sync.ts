/**
 * Bolletje: de AI-telefoonassistent van IJs uit de Polder (088-0405885).
 *
 * Elk telefoongesprek levert een mail op met een samenvatting, het nummer, de
 * naam en wat de beller wilde. Die mails worden gewoon opgevolgd, maar ze staan
 * los in het archief: er is nergens te zien hoeveel aanvragen er via de telefoon
 * binnenkomen, wat mensen vragen, en hoeveel ervan een boeking worden.
 *
 * Deze sync leest die mails uit Mail_Archief en zet er leads van, zodat de
 * telefoon net zo meetbaar wordt als het contactformulier.
 */

import { directus } from '../config/directus';
import { readItems, createItem } from '@directus/sdk';
import { logger } from '../utils/logger';

// Woorden waarmee bellers een kapotte lijn beschrijven. In juli 2026 werkte de
// doorschakeling naar de mobiel een tijd niet - getest na de bouw, daarna stil
// gesneuveld. Het enige spoor waren bellers die klaagden dat ze niet werden
// teruggebeld en steeds werden weggedrukt. Niemand las die samenvattingen.
const STORINGSSIGNAAL = /disconnect|dropped|niet teruggebeld|not received a call|promised a call back|transferred multiple|verbinding verbroken|weer weggevallen|meerdere keren gebeld|called multiple times|unable to get through|niet doorverbonden/i;
const CLUSTER_DREMPEL = 3;

// Korter dan dit is iemand die ophangt voordat het gesprek begint.
const MIN_DUUR_SECONDEN = 20;

interface BolletjeGesprek {
  interactieId: string;
  tijd: string | null;
  duur: number;
  samenvatting: string | null;
  naam: string | null;
  telefoon: string | null;
  datumFeest: string | null;
  wagen: string | null;
}

/** De mail is markdown met "- **Label** - waarde" regels. */
function veld(tekst: string, label: string): string | null {
  const m = tekst.match(new RegExp(`\\*\\*${label}\\*\\*\\s*-\\s*([^\\n]+?)(?=\\s*-\\s*\\*\\*|\\n|$)`, 'i'));
  return m ? m[1].trim() : null;
}

export function parseBolletjeMail(tekst: string): BolletjeGesprek | null {
  const id = tekst.match(/Interaction\s+(\d{4,})/);
  if (!id) return null;
  // Een samenvatting loopt door tot het volgende "- **Label**".
  const sam = tekst.match(/\*\*Summary\*\*\s*-\s*([\s\S]*?)(?=\s*-\s*\*\*[A-Z])/i);
  return {
    interactieId: id[1],
    tijd: veld(tekst, 'Time'),
    duur: Number(veld(tekst, 'Duration \\(seconds\\)')) || 0,
    samenvatting: sam ? sam[1].replace(/\s+/g, ' ').trim() : null,
    naam: veld(tekst, 'Name'),
    telefoon: veld(tekst, 'Formatted Phone'),
    datumFeest: veld(tekst, 'Datum_feest'),
    wagen: veld(tekst, 'Wagen'),
  };
}

/** "23 September 2026 09:26" -> ISO. Engelse maandnamen, want zo levert Talkative het aan. */
function naarIso(tijd: string | null): string | null {
  if (!tijd) return null;
  const d = new Date(tijd.replace(/(\d+)\s+(\w+)\s+(\d{4})/, '$2 $1, $3'));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export interface BolletjeSyncResult {
  mails: number;
  gesprekken: number;
  te_kort: number;
  nieuw: number;
  bestond_al: number;
}

export async function syncBolletjeLeads(bedrijfId: number): Promise<BolletjeSyncResult> {
  const mails = (await directus.request(
    readItems('Mail_Archief', {
      filter: { bedrijf: { _eq: bedrijfId } }, limit: -1,
      fields: ['datum', 'van', 'onderwerp', 'tekst'],
      sort: ['-datum'],
    }),
  )) as Array<{ datum?: string; van?: string; onderwerp?: string; tekst?: string }>;

  const vanBolletje = mails.filter(
    (m) => /bolletje/i.test(String(m.van || '')) || /Bolletje queue/i.test(String(m.onderwerp || '')),
  );

  const bestaand = (await directus.request(
    readItems('Leads', {
      filter: { bedrijf: { _eq: bedrijfId }, bron: { _eq: 'bolletje' } }, limit: -1,
      fields: ['externe_id'] as never,
    }),
  )) as Array<{ externe_id?: string }>;
  const bekend = new Set(bestaand.map((l) => l.externe_id).filter(Boolean) as string[]);

  let nieuw = 0, bestond = 0, teKort = 0, gesprekken = 0;

  for (const mail of vanBolletje) {
    const g = parseBolletjeMail(String(mail.tekst || ''));
    if (!g) continue;
    gesprekken++;

    // Ophangers leveren geen aanvraag op; die vervuilen alleen de lijst.
    if (g.duur < MIN_DUUR_SECONDEN && !g.samenvatting) { teKort++; continue; }
    if (bekend.has(g.interactieId)) { bestond++; continue; }

    const wensen = [
      g.datumFeest ? `Gewenste datum: ${g.datumFeest}` : null,
      g.wagen ? `Gevraagd middel: ${g.wagen}` : null,
      `Gesprek duurde ${g.duur} seconden.`,
    ].filter(Boolean).join('\n');

    await directus.request(
      createItem('Leads', {
        bedrijf: bedrijfId,
        bron: 'bolletje',
        externe_id: g.interactieId,
        naam: g.naam || 'Onbekend (via Bolletje)',
        telefoon: g.telefoon || null,
        bericht: g.samenvatting || 'Geen samenvatting; kort gesprek.',
        notities: wensen,
        status: 'new',
        // Een langer gesprek betekent dat iemand echt aan het plannen was.
        lead_temperature: g.duur > 120 ? 'hot' : g.duur > 45 ? 'warm' : 'cold',
        first_interaction: naarIso(g.tijd),
        last_interaction: naarIso(g.tijd),
        interaction_count: 1,
        product_type: 'contact',
        product_details: { interactie: g.interactieId, duur_seconden: g.duur, wagen: g.wagen, datum_feest: g.datumFeest },
      } as never),
    );
    bekend.add(g.interactieId);
    nieuw++;
  }

  await meldStoringssignaal(bedrijfId, vanBolletje);

  logger.info(`Bolletje-sync bedrijf ${bedrijfId}: ${vanBolletje.length} mails, ${gesprekken} gesprekken, ${nieuw} nieuwe leads, ${bestond} bekend, ${teKort} te kort`);
  return { mails: vanBolletje.length, gesprekken, te_kort: teKort, nieuw, bestond_al: bestond };
}


/**
 * Meerdere bellers op één dag die klagen dat ze niet worden teruggebeld of
 * steeds worden weggedrukt: dan is er iets stuk aan de lijn, niet aan de
 * bellers. Zet er een taak op, want zo'n storing valt verder nergens op.
 */
async function meldStoringssignaal(
  bedrijfId: number,
  mails: Array<{ datum?: string; tekst?: string }>,
): Promise<void> {
  const perDag = new Map<string, number>();
  const grens = Date.now() - 14 * 86400000;

  for (const m of mails) {
    const dag = String(m.datum || '').slice(0, 10);
    if (!dag || new Date(dag).getTime() < grens) continue;
    const g = parseBolletjeMail(String(m.tekst || ''));
    if (g?.samenvatting && STORINGSSIGNAAL.test(g.samenvatting)) {
      perDag.set(dag, (perDag.get(dag) || 0) + 1);
    }
  }

  for (const [dag, aantal] of perDag) {
    if (aantal < CLUSTER_DREMPEL) continue;
    const titel = `Telefoonlijn nakijken — ${aantal} klachten op ${dag}`;
    const open = (await directus.request(readItems('Tasks', {
      filter: { status: { _neq: 'done' } } as never, limit: -1, fields: ['title'] as never,
    }))) as Array<{ title?: string }>;
    if (open.some((t) => String(t.title || '') === titel)) continue;

    await directus.request(createItem('Tasks', {
      title: titel,
      description: `Op ${dag} klaagden ${aantal} bellers bij Bolletje over niet teruggebeld worden of een verbroken verbinding. `
        + `Dat wijst op een storing in de doorschakeling, niet op ongeduldige klanten: in juli 2026 lag de doorschakeling `
        + `naar de mobiel er stil uit terwijl hij na de bouw gewoon getest was. Controleer de doorschakeling van 088-0405885 `
        + `naar de mobiel, en bel de mensen van die dag terug.`,
      bedrijf: bedrijfId, status: 'open', priority: 'high', category: 'tech', assigned_to: 'Luke',
    } as never));
    logger.warn(`Bolletje: ${aantal} klachten over de lijn op ${dag}, taak aangemaakt`);
  }
}
