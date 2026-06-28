/**
 * Spil: de planner.
 *
 * Koppelt elk event aan een middel + bemensing, en bewaakt de regels:
 *  - niet meer van een middel inzetten dan je hebt (geen dubbele ijskraam op 1 dag),
 *  - alleen mensen die het middel mogen/kunnen bedienen,
 *  - een ijsscooter heeft iemand met scooter-rijbewijs nodig,
 *  - persoonsregels (Chloe geen scooter, Miles geen rijbewijs, Levi licht, Charissa inactief).
 *
 * Geeft per dag een voorstel + alerts bij conflicten of tekorten. Beslist niets
 * onomkeerbaars: het is een planningsvoorstel ter review.
 */

import { directus } from '../config/directus';
import { readItems } from '@directus/sdk';

// event_type (vrije tekst) -> middel-type
function middelType(eventType: string): string {
  const t = String(eventType || '').toLowerCase();
  if (/bedford|ijsbus|bus/.test(t)) return 'bedford';
  if (/kraam/.test(t)) return 'ijskraam';
  if (/scooter/.test(t)) return 'ijsscooter';
  if (/gelato|bar/.test(t)) return 'gelatobar';
  if (/slush/.test(t)) return 'slush';
  return 'ijskraam'; // default
}

interface CrewLid { naam: string; status: string; vaardigheden: string[]; rijbewijs_scooter: boolean; beperkingen: string; }

/** Kan dit crewlid dit middel bedienen, gegeven de persoonsregels? */
function kanBedienen(c: CrewLid, mtype: string): boolean {
  if (c.status === 'inactief') return false;
  const v = (c.vaardigheden || []).map((x) => String(x).toLowerCase());
  if (mtype === 'ijsscooter') {
    // Chloe expliciet niet; verder iedereen die scooter of scooter-verkoop kan
    if (/geen.*scooter|nooit.*scooter/i.test(c.beperkingen || '')) return false;
    return v.includes('scooter') || v.includes('scooter-verkoop');
  }
  if (mtype === 'bedford') return v.includes('bedford');
  if (mtype === 'ijskraam') return v.includes('ijskraam') || v.includes('verkoop');
  return v.includes('verkoop') || v.includes(mtype);
}

export interface DagPlan {
  datum: string;
  events: Array<{
    id: number; titel: string; locatie: string; middel: string;
    bemensing: string[]; alerts: string[];
  }>;
  alerts: string[];
}

export async function planAgenda(bedrijfId: number): Promise<DagPlan[]> {
  const gisteren = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const [boekingen, middelen, crewRaw] = await Promise.all([
    directus.request(readItems('Boekingen', { filter: { bedrijf: { _eq: bedrijfId }, event_datum: { _gte: gisteren } } as any, sort: ['event_datum'], limit: -1 })) as Promise<any[]>,
    directus.request(readItems('Middelen', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 })) as Promise<any[]>,
    directus.request(readItems('Crew', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 })) as Promise<any[]>,
  ]);

  const voorraad = new Map<string, number>();
  for (const m of middelen) voorraad.set(String(m.type), (voorraad.get(String(m.type)) || 0) + (Number(m.aantal) || 0));

  const crew: CrewLid[] = crewRaw.map((c) => ({
    naam: String(c.naam), status: String(c.status || 'actief'),
    vaardigheden: Array.isArray(c.vaardigheden) ? c.vaardigheden : [],
    rijbewijs_scooter: !!c.rijbewijs_scooter, beperkingen: String(c.beperkingen || ''),
  }));

  // groepeer events per dag
  const perDag = new Map<string, any[]>();
  for (const b of boekingen) {
    if (!b.event_datum) continue;
    const d = String(b.event_datum).slice(0, 10);
    (perDag.get(d) || perDag.set(d, []).get(d)!).push(b);
  }

  const planning: DagPlan[] = [];
  for (const [datum, evs] of [...perDag.entries()].sort()) {
    const dagAlerts: string[] = [];
    const ingezet = new Map<string, number>(); // middel-type -> aantal vandaag gepland
    const bezetteCrew = new Set<string>();
    const events: DagPlan['events'] = [];

    for (const e of evs) {
      const mtype = middelType(e.event_type);
      const evAlerts: string[] = [];

      // middel-capaciteit
      const gepland = (ingezet.get(mtype) || 0) + 1;
      ingezet.set(mtype, gepland);
      const beschikbaar = voorraad.get(mtype) || 0;
      if (gepland > beschikbaar) evAlerts.push(`Te weinig ${mtype}: ${gepland} nodig op deze dag, maar ${beschikbaar} beschikbaar`);

      // bemensing: kies vrije, geschikte crew (actief eerst, dan licht)
      const kandidaten = crew
        .filter((c) => !bezetteCrew.has(c.naam) && kanBedienen(c, mtype))
        .sort((a, b) => (a.status === 'licht' ? 1 : 0) - (b.status === 'licht' ? 1 : 0));

      const bemensing: string[] = [];
      if (mtype === 'ijsscooter') {
        // minstens iemand met rijbewijs
        const bestuurder = kandidaten.find((c) => c.rijbewijs_scooter);
        if (bestuurder) { bemensing.push(bestuurder.naam); bezetteCrew.add(bestuurder.naam); }
        else evAlerts.push('Geen scooter-rijbewijs beschikbaar voor deze scooter');
      } else {
        const persoon = kandidaten[0];
        if (persoon) { bemensing.push(persoon.naam); bezetteCrew.add(persoon.naam); }
        else evAlerts.push(`Niemand vrij/geschikt voor ${mtype}`);
      }

      events.push({ id: e.id, titel: String(e.titel || e.contact_naam || 'Event'), locatie: String(e.locatie || e.contact_plaats || ''), middel: mtype, bemensing, alerts: evAlerts });
      evAlerts.forEach((a) => dagAlerts.push(`${String(e.titel || e.contact_naam)}: ${a}`));
    }

    planning.push({ datum, events, alerts: dagAlerts });
  }

  return planning;
}
