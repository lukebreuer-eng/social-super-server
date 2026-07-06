/**
 * Beschikbaarheid: vat de planning van de komende weken samen tot een korte tekst,
 * zodat de mail-agent (Bode) bij een datumvraag WEET of we die dag nog kunnen.
 * Gebruikt Spil's planAgenda, die middel + bemensing + conflicten al berekent.
 */

import { planAgenda } from './spil';

const MAAND = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const DAG = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
function nlDatum(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  return `${DAG[d.getDay()]} ${d.getDate()} ${MAAND[d.getMonth()]}`;
}

/**
 * Korte, feitelijke samenvatting van de bezetting per dag voor de komende `dagen`.
 * Bedoeld als context voor de mail-agent, niet om zelf toezeggingen te doen.
 */
export async function getBeschikbaarheidTekst(bedrijfId: number, dagen = 35): Promise<string> {
  let plan;
  try { plan = await planAgenda(bedrijfId); } catch { return ''; }
  if (!plan || !plan.length) return 'Geen events in de planning voor de komende weken; ruimte lijkt vrij (bevestig altijd met de eigenaar).';

  const grens = new Date(); grens.setDate(grens.getDate() + dagen);
  const grensStr = grens.toISOString().slice(0, 10);

  const regels: string[] = [];
  for (const dag of plan) {
    if (dag.datum > grensStr) continue;
    const middelen = dag.events.map((e) => e.middel && e.middel !== '?' ? e.middel : 'onbekend');
    const conflict = dag.alerts && dag.alerts.length ? ` [LET OP: ${dag.alerts.join('; ')}]` : '';
    regels.push(`- ${nlDatum(dag.datum)}: ${dag.events.length} inzet (${middelen.join(', ')})${conflict}`);
  }
  if (!regels.length) return 'Geen events in de komende weken; ruimte lijkt vrij (bevestig altijd met de eigenaar).';

  return `Bezetting komende weken (uit de planning):\n${regels.join('\n')}\n\n` +
    `Regels voor beschikbaarheid:\n` +
    `- We hebben 1 Bedford (ijsbus/ijswagen), 1 ijskraam (aanhanger), 3 ijsscooters, 2 gelatobars, 1 slushmachine.\n` +
    `- De ijskraam EN de Bedford moeten allebei door Luke of Levi gereden worden, en dat zijn de enige twee. ` +
    `Staat er op een dag al een ijskraam of Bedford gepland, dan kan er meestal GEEN tweede groot voertuig (ijswagen/ijskraam) meer bij op diezelfde dag.\n` +
    `Gebruik dit om eerlijk te zeggen of een gevraagde datum waarschijnlijk vol of vrij is. Doe geen harde toezegging: bevestig dat de eigenaar het definitief vastlegt.`;
}
