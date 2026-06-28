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
  return 'onbekend'; // niet gokken bij ontbrekende info
}

interface CrewLid { naam: string; status: string; vaardigheden: string[]; rijbewijs_scooter: boolean; beperkingen: string; }

function skills(c: CrewLid): string[] { return (c.vaardigheden || []).map((x) => String(x).toLowerCase()); }
function actief(c: CrewLid): boolean { return c.status !== 'inactief'; }
function magScooter(c: CrewLid): boolean { return !/geen.*scooter|nooit.*scooter/i.test(c.beperkingen || ''); }

// Verkoop-voorkeur: Miles eerst (rijzende ster, meeste schepervaring), dan Chloe, Gide, Lars.
// Luke/Levi rijden de grote middelen en zijn geen eerste keus als losse verkoper.
const VERKOOP_PRIO: Record<string, number> = { miles: 0, chloe: 1, gide: 2, lars: 3, levi: 7, luke: 9 };
function prio(c: CrewLid): number { return VERKOOP_PRIO[c.naam.toLowerCase()] ?? 5; }

// IJskraam (trekken) en Bedford (rijden) kunnen alleen Luke of Levi. Levi eerst,
// zodat Luke ruimte houdt voor productie/onderhoud.
function grootVoertuigBestuurder(crew: CrewLid[], bezet: Set<string>, cap: string): CrewLid | undefined {
  return crew
    .filter((c) => actief(c) && !bezet.has(c.naam) && skills(c).includes(cap))
    .sort((a, b) => (a.naam.toLowerCase() === 'levi' ? 0 : 1) - (b.naam.toLowerCase() === 'levi' ? 0 : 1))[0];
}

export interface DagPlan {
  datum: string;
  events: Array<{
    id: number; titel: string; locatie: string; middel: string; offertenummer: string;
    bemensing: string[]; vastgelegd: boolean; alerts: string[];
  }>;
  alerts: string[];
}

export async function planAgenda(bedrijfId: number): Promise<DagPlan[]> {
  const vandaag = new Date().toISOString().slice(0, 10);
  const [boekingen, middelen, crewRaw, afwezig] = await Promise.all([
    directus.request(readItems('Boekingen', { filter: { bedrijf: { _eq: bedrijfId }, event_datum: { _gte: vandaag } } as any, sort: ['event_datum'], limit: -1 })) as Promise<any[]>,
    directus.request(readItems('Middelen', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 })) as Promise<any[]>,
    directus.request(readItems('Crew', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 })) as Promise<any[]>,
    directus.request(readItems('Afwezigheid', { filter: { bedrijf: { _eq: bedrijfId } }, limit: -1 })) as Promise<any[]>,
  ]);

  // wie is op een gegeven datum weg
  const wegOp = (naam: string, datum: string) => afwezig.some((a) =>
    String(a.naam || '').toLowerCase() === naam.toLowerCase() &&
    String(a.van || '') <= datum && datum <= String(a.tot || '9999'));

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
    // crew die deze dag beschikbaar is (afwezigen eruit)
    const crewVandaag = crew.filter((c) => !wegOp(c.naam, datum));

    for (const e of evs) {
      const mtype = middelType(e.event_type);
      const evAlerts: string[] = [];
      const bemensing: string[] = [];

      // 1) Heb jij de bemensing al vastgelegd? Dan wint die, Spil bewaakt alleen.
      const vastgelegd = String(e.bemensing || '').trim();
      if (vastgelegd) {
        vastgelegd.split(/[,;]+/).map((s) => s.trim()).filter(Boolean).forEach((n) => { bemensing.push(n); bezetteCrew.add(n); });
        if (mtype !== 'onbekend') {
          const gepland = (ingezet.get(mtype) || 0) + 1;
          ingezet.set(mtype, gepland);
          const beschikbaar = voorraad.get(mtype) || 0;
          if (gepland > beschikbaar) evAlerts.push(`Te weinig ${mtype}: ${gepland} nodig op deze dag, maar ${beschikbaar} beschikbaar`);
        }
        events.push({ id: e.id, offertenummer: String(e.offertenummer || ''), titel: String(e.titel || e.contact_naam || 'Event'), locatie: String(e.locatie || e.contact_plaats || ''), middel: mtype === 'onbekend' ? '?' : mtype, bemensing, vastgelegd: true, alerts: evAlerts });
        evAlerts.forEach((a) => dagAlerts.push(`${String(e.titel || e.contact_naam)}: ${a}`));
        continue;
      }

      // 2) Niet vastgelegd en middel onbekend? Niet gokken, maar vragen.
      if (mtype === 'onbekend') {
        evAlerts.push('Middel onbekend, vul het middel + bemensing in');
        events.push({ id: e.id, offertenummer: String(e.offertenummer || ''), titel: String(e.titel || e.contact_naam || 'Event'), locatie: String(e.locatie || e.contact_plaats || ''), middel: '?', bemensing: [], vastgelegd: false, alerts: evAlerts });
        evAlerts.forEach((a) => dagAlerts.push(`${String(e.titel || e.contact_naam)}: ${a}`));
        continue;
      }

      // 3) Voorstel volgens de regels (jij kunt overschrijven)
      const gepland = (ingezet.get(mtype) || 0) + 1;
      ingezet.set(mtype, gepland);
      const beschikbaar = voorraad.get(mtype) || 0;
      if (gepland > beschikbaar) evAlerts.push(`Te weinig ${mtype}: ${gepland} nodig op deze dag, maar ${beschikbaar} beschikbaar`);

      const vrij = (pred: (c: CrewLid) => boolean) =>
        crewVandaag.filter((c) => actief(c) && !bezetteCrew.has(c.naam) && pred(c)).sort((a, b) => prio(a) - prio(b));
      const pak = (c?: CrewLid) => { if (c) { bemensing.push(c.naam); bezetteCrew.add(c.naam); } };

      if (mtype === 'ijskraam') {
        // aanhanger: getrokken door Luke of Levi (Levi eerst), plus een verkoper
        const tower = grootVoertuigBestuurder(crewVandaag, bezetteCrew, 'kraam-trekken');
        if (!tower) evAlerts.push('Geen Luke of Levi vrij om de ijskraam te trekken');
        else { pak(tower); pak(vrij((c) => skills(c).includes('verkoop'))[0]); }
      } else if (mtype === 'bedford') {
        // ijsbus: gereden door Luke of Levi (Levi eerst), plus een verkoper
        const driver = grootVoertuigBestuurder(crewVandaag, bezetteCrew, 'bedford-rijden');
        if (!driver) evAlerts.push('Geen Luke of Levi vrij om de Bedford te rijden');
        else { pak(driver); pak(vrij((c) => skills(c).includes('verkoop'))[0]); }
      } else if (mtype === 'ijsscooter') {
        const driver = vrij((c) => c.rijbewijs_scooter && magScooter(c))[0]; // Gide of Lars (rijbewijs)
        if (!driver) evAlerts.push('Geen bestuurder met scooter-rijbewijs (Gide of Lars) vrij');
        else {
          const miles = crewVandaag.find((c) => c.naam.toLowerCase() === 'miles' && actief(c) && !bezetteCrew.has(c.naam));
          if (miles) { pak(miles); pak(driver); } // Miles voorkeur als verkoper + bestuurder erbij
          else pak(driver); // Gide of Lars mag ook solo
        }
      } else {
        const v = vrij((c) => skills(c).includes('verkoop'))[0];
        if (!v) evAlerts.push(`Niemand vrij/geschikt voor ${mtype}`); else pak(v);
      }

      events.push({ id: e.id, offertenummer: String(e.offertenummer || ''), titel: String(e.titel || e.contact_naam || 'Event'), locatie: String(e.locatie || e.contact_plaats || ''), middel: mtype, bemensing, vastgelegd: false, alerts: evAlerts });
      evAlerts.forEach((a) => dagAlerts.push(`${String(e.titel || e.contact_naam)}: ${a}`));
    }

    planning.push({ datum, events, alerts: dagAlerts });
  }

  return planning;
}
