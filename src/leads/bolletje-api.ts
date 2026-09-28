/**
 * De tools die Bolletje (de AI-telefoonassistent) tijdens een gesprek mag
 * aanroepen. Tot nu toe kende Bolletje alleen een gecrawlde website en moest
 * hij voor alles doorverwijzen naar een mens. Met deze endpoints kan hij aan de
 * telefoon in de agenda kijken, de echte wagens en smaken noemen en een aanvraag
 * vastleggen — precies het gat dat in juli 2026 viel, toen er niemand kon
 * opnemen en er die maand geen enkele offerte werd gewonnen.
 *
 * BEVEILIGING: een telefoonnummer is geen identiteitsbewijs, nummerherkenning
 * is te vervalsen. Daarom geeft dit alles wat een bot aan een wildvreemde mag
 * vertellen, en administratie alleen als bevestiging van wat de beller zelf al
 * noemt: een factuurstatus op factuurnummer, zonder bedragen, namen of adressen.
 */

import { Router } from 'express';
import axios from 'axios';
import { directus } from '../config/directus';
import { readItems, createItem } from '@directus/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const bolletjeRouter = Router();

// Elke tool-aanroep moet de sleutel meesturen; deze endpoints staan open op het
// internet omdat Talkative ze vanaf hun eigen servers aanroept.
bolletjeRouter.use((req, res, next) => {
  const sleutel = req.header('x-bolletje-key') || req.query.key;
  if (!env.BOLLETJE_API_KEY || sleutel !== env.BOLLETJE_API_KEY) {
    logger.warn(`Bolletje-tool geweigerd: ongeldige sleutel vanaf ${req.ip}`);
    return res.status(401).json({ error: 'ongeldige sleutel' });
  }
  next();
});

const BEDRIJF = 7;

/** Is deze datum nog vrij? Antwoord in gewone taal, want Bolletje leest het voor. */
bolletjeRouter.get('/beschikbaarheid', async (req, res) => {
  try {
    const datum = String(req.query.datum || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) {
      return res.status(400).json({ error: 'geef datum als JJJJ-MM-DD' });
    }
    const boekingen = (await directus.request(readItems('Boekingen', {
      filter: { bedrijf: { _eq: BEDRIJF }, status: { _eq: 'gewonnen' } }, limit: -1,
      fields: ['event_datum', 'middel', 'contact_naam'],
    }))) as Array<{ event_datum?: string; middel?: string }>;

    const bezet = boekingen.filter((b) => String(b.event_datum || '').slice(0, 10) === datum);
    const middelen = bezet.map((b) => b.middel).filter(Boolean);
    const dag = new Date(datum).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });

    res.json({
      datum, dag, aantal_boekingen: bezet.length, bezette_middelen: middelen,
      vrij: bezet.length === 0,
      antwoord: bezet.length === 0
        ? `${dag} staat nog helemaal vrij.`
        : bezet.length < 2
          ? `Op ${dag} staat al één klus, maar er is nog ruimte. Een collega bevestigt het definitief.`
          : `${dag} is al aardig vol met ${bezet.length} klussen. Een collega kijkt of het nog past.`,
    });
  } catch (error) {
    logger.error('Bolletje beschikbaarheid:', error);
    res.status(500).json({ error: 'kon de agenda niet lezen' });
  }
});

/** De wagens met hun echte voorwaarden, zodat Bolletje niets belooft wat niet kan. */
bolletjeRouter.get('/wagens', async (_req, res) => {
  try {
    const middelen = (await directus.request(readItems('Middelen', {
      filter: { bedrijf: { _eq: BEDRIJF } }, limit: -1, fields: ['naam', 'type', 'aantal'],
    }))) as Array<{ naam?: string; type?: string; aantal?: number }>;

    // Deze voorwaarden staan in de kennisbank en gelden hard.
    const voorwaarden: Record<string, string> = {
      bedford: 'Minimaal 150 bollen. 8 smaken plus milkshakes. De blikvanger.',
      ijskraam: 'Minimaal 150 bollen. 9 smaken, uit te breiden met slush of ijskoffie. Binnen en buiten.',
      ijsscooter: 'Vanaf 40 bollen. 6 smaken, volledig zelfvoorzienend zonder stroom. Alleen in Zeewolde en directe omgeving.',
      gelatobar: 'Geen vast bolminimum, keuze uit 3 of 6 smaken. Past door elke deur en lift. Zelfservice: gasten scheppen zelf.',
      slush: 'Slushmachine, uit te breiden op de ijskraam.',
    };
    res.json({
      werkgebied: 'Ongeveer 50 kilometer rond Zeewolde. Daarbuiten in overleg.',
      wagens: middelen.map((m) => ({
        naam: m.naam, aantal: m.aantal,
        voorwaarden: voorwaarden[String(m.type)] || null,
      })),
      let_op: 'Noem geen prijzen behalve de gelatobar-pakketten. Voor de rest maken we een offerte op maat.',
    });
  } catch (error) {
    logger.error('Bolletje wagens:', error);
    res.status(500).json({ error: 'kon de wagens niet ophalen' });
  }
});

/** De actuele smaken, rechtstreeks uit de kennisbank die Luke bijhoudt. */
bolletjeRouter.get('/smaken', async (_req, res) => {
  try {
    const kb = (await directus.request(readItems('AI_Knowledge_Base', {
      filter: { bedrijf: { _eq: BEDRIJF } }, limit: -1, fields: ['title', 'content'],
    }))) as Array<{ title?: string; content?: string }>;
    const entry = kb.find((k) => /smakenlijst/i.test(String(k.title || '')));
    const inhoud = String(entry?.content || '');
    const lijst = (inhoud.match(/ACTIEVE SMAKEN[^:]*:\s*([^.]+)\./i) || [])[1];
    const smaken = lijst ? lijst.split(',').map((s) => s.trim()).filter(Boolean) : [];
    res.json({
      aantal: smaken.length, smaken,
      let_op: 'Smaken wisselen per seizoen. Beloof nooit dat een specifieke smaak er is; noem ze als voorbeeld.',
    });
  } catch (error) {
    logger.error('Bolletje smaken:', error);
    res.status(500).json({ error: 'kon de smaken niet ophalen' });
  }
});

/** Een aanvraag vastleggen: lead plus terugbeltaak, zodat niets blijft liggen. */
bolletjeRouter.post('/aanvraag', async (req, res) => {
  try {
    const { naam, telefoon, datum, wagen, aantal_personen, omschrijving, plaats, interactie_id } = req.body || {};
    if (!telefoon && !naam) return res.status(400).json({ error: 'geef minstens een naam of telefoonnummer' });

    const wensen = [
      datum ? `Gewenste datum: ${datum}` : null,
      wagen ? `Gevraagd middel: ${wagen}` : null,
      aantal_personen ? `Aantal personen: ${aantal_personen}` : null,
      plaats ? `Locatie: ${plaats}` : null,
    ].filter(Boolean).join('\n');

    const lead = await directus.request(createItem('Leads', {
      bedrijf: BEDRIJF, bron: 'bolletje', externe_id: interactie_id ? String(interactie_id) : null,
      naam: naam || 'Onbekend (via Bolletje)', telefoon: telefoon || null,
      bericht: omschrijving || 'Telefonische aanvraag via Bolletje.',
      notities: wensen, status: 'new', lead_temperature: 'hot',
      first_interaction: new Date().toISOString(), last_interaction: new Date().toISOString(),
      interaction_count: 1, product_type: 'contact',
      product_details: { datum, wagen, aantal_personen, plaats, via: 'bolletje-tool' },
    } as never)) as { id: number };

    await directus.request(createItem('Tasks', {
      title: `Bel terug: ${naam || telefoon} — ${wagen || 'ijscatering'}${datum ? ` op ${datum}` : ''}`,
      description: `Telefonische aanvraag via Bolletje.\n\n${wensen}\n\n${omschrijving || ''}\n\nTelefoon: ${telefoon || 'onbekend'}\nLead #${lead.id}`,
      bedrijf: BEDRIJF, status: 'open', priority: 'high', category: 'sales', assigned_to: 'Luke',
    } as never));

    logger.info(`Bolletje legde een aanvraag vast: lead ${lead.id} (${naam || telefoon})`);
    res.json({ ok: true, lead_id: lead.id, antwoord: 'Ik heb het genoteerd, een van ons belt je vandaag nog terug.' });
  } catch (error) {
    logger.error('Bolletje aanvraag:', error);
    res.status(500).json({ error: 'kon de aanvraag niet vastleggen' });
  }
});

/**
 * Factuurstatus. Bewust karig: alleen op factuurnummer, en alleen of hij
 * openstaat of betaald is. Geen bedragen, geen namen, geen adressen — een
 * beller is aan de telefoon niet te identificeren en nummerherkenning is te
 * vervalsen. Wie meer wil weten, wordt teruggebeld.
 */
bolletjeRouter.get('/factuur', async (req, res) => {
  try {
    const nummer = String(req.query.nummer || '').trim();
    if (!/^\d{4}-\d{3,5}$/.test(nummer)) {
      return res.status(400).json({ error: 'geef een factuurnummer als 2026-0031' });
    }
    const token = env.IJS_MONEYBIRD_API_TOKEN;
    if (!token) return res.status(503).json({ error: 'administratie niet bereikbaar' });

    const admin = env.IJS_MONEYBIRD_ADMINISTRATION_ID || '299278260688127925';
    const { data } = await axios.get(
      `https://moneybird.com/api/v2/${admin}/sales_invoices.json?filter=invoice_id:${encodeURIComponent(nummer)}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 },
    );
    const factuur = Array.isArray(data) ? data[0] : null;
    if (!factuur) return res.json({ gevonden: false, antwoord: 'Dat factuurnummer kan ik zo niet vinden. Een collega kijkt er even naar.' });

    const betaald = ['paid'].includes(String(factuur.state));
    res.json({
      gevonden: true, nummer, betaald,
      antwoord: betaald
        ? `Factuur ${nummer} staat bij ons als betaald genoteerd.`
        : `Factuur ${nummer} staat nog open. Een collega kan de details met je doornemen.`,
    });
  } catch (error) {
    logger.error('Bolletje factuur:', error);
    res.status(500).json({ error: 'kon de administratie niet raadplegen' });
  }
});

/** Wie kan er op die datum, en wie mag dat middel rijden? */
bolletjeRouter.get('/personeel', async (req, res) => {
  try {
    const datum = String(req.query.datum || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) return res.status(400).json({ error: 'geef datum als JJJJ-MM-DD' });
    const middel = String(req.query.middel || '').toLowerCase();

    const [crew, afwezig] = await Promise.all([
      directus.request(readItems('Crew', { filter: { bedrijf: { _eq: BEDRIJF }, status: { _eq: 'actief' } }, limit: -1 })) as Promise<any[]>,
      directus.request(readItems('Afwezigheid', { filter: { bedrijf: { _eq: BEDRIJF } }, limit: -1 })) as Promise<any[]>,
    ]);

    const wegOpDatum = new Set(
      afwezig.filter((a) => String(a.van || '') <= datum && datum <= String(a.tot || '')).map((a) => String(a.naam)),
    );
    // Voor de Bedford en de kraam is een rijbewijs nodig; de scooter heeft een eigen veld.
    const vaardigheidVoor: Record<string, string> = { bedford: 'bedford-rijden', ijskraam: 'kraam-trekken', aanhanger: 'kraam-trekken' };
    const nodig = vaardigheidVoor[middel];

    const beschikbaar = crew.filter((c) => {
      if (wegOpDatum.has(String(c.naam))) return false;
      if (middel === 'ijsscooter' || middel === 'scooter') return c.rijbewijs_scooter === true;
      if (nodig) return JSON.stringify(c.vaardigheden || []).includes(nodig);
      return true;
    });

    res.json({
      datum, middel: middel || null,
      beschikbaar: beschikbaar.map((c) => ({ naam: c.naam, rol: c.rol, let_op: c.beperkingen || null })),
      afwezig: [...wegOpDatum],
      antwoord: beschikbaar.length
        ? `Er is bemensing beschikbaar op die dag. Een collega bevestigt wie er komt.`
        : `Op die dag is het krap met personeel. Een collega belt je terug of het lukt.`,
    });
  } catch (error) {
    logger.error('Bolletje personeel:', error);
    res.status(500).json({ error: 'kon het rooster niet lezen' });
  }
});

/**
 * Zet een offerte KLAAR in Moneybird als concept. Bewust niet verstuurd: een
 * bot die zelfstandig offertes de deur uit doet, stuurt bij een misverstaan
 * aantal of een verkeerde datum een verkeerde prijs naar een klant. Nu staat
 * hij binnen een minuut in Moneybird en hoeft er alleen op verzenden gedrukt.
 */
bolletjeRouter.post('/offerte', async (req, res) => {
  try {
    const { naam, email, telefoon, datum, wagen, aantal_personen, bollen_per_persoon, omschrijving } = req.body || {};
    if (!naam) return res.status(400).json({ error: 'naam is nodig voor een offerte' });

    const token = env.IJS_MONEYBIRD_API_TOKEN;
    if (!token) return res.status(503).json({ error: 'administratie niet bereikbaar' });
    const admin = env.IJS_MONEYBIRD_ADMINISTRATION_ID || '299278260688127925';
    const headers = { Authorization: `Bearer ${token}` };
    const base = `https://moneybird.com/api/v2/${admin}`;

    // Bestaand contact hergebruiken, anders een nieuw aanmaken.
    let contactId: string | null = null;
    try {
      const { data } = await axios.get(`${base}/contacts.json?query=${encodeURIComponent(naam)}`, { headers, timeout: 15000 });
      if (Array.isArray(data) && data[0]) contactId = String(data[0].id);
    } catch { /* nieuw contact aanmaken */ }

    if (!contactId) {
      const [voor, ...rest] = String(naam).split(' ');
      const { data } = await axios.post(`${base}/contacts.json`, {
        contact: { firstname: voor, lastname: rest.join(' '), email: email || '', phone: telefoon || '' },
      }, { headers, timeout: 20000 });
      contactId = String(data.id);
    }

    const bollen = (Number(aantal_personen) || 0) * (Number(bollen_per_persoon) || 2);
    const regels = [
      { description: `${wagen || 'IJscatering'}${datum ? ` — ${datum}` : ''}${omschrijving ? `\n${omschrijving}` : ''}`, amount: '1', price: 0 },
      ...(bollen ? [{ description: `${aantal_personen} personen × ${bollen_per_persoon || 2} bollen`, amount: String(bollen), price: 0 }] : []),
    ];

    const { data: offerte } = await axios.post(`${base}/estimates.json`, {
      estimate: {
        contact_id: contactId,
        reference: `Telefonische aanvraag via Bolletje${datum ? ` — ${datum}` : ''}`,
        details_attributes: regels,
      },
    }, { headers, timeout: 25000 });

    logger.info(`Bolletje zette offerte ${offerte.estimate_id || offerte.id} klaar als concept voor ${naam}`);
    res.json({
      ok: true, offerte_id: offerte.id, nummer: offerte.estimate_id || null, status: 'concept',
      let_op: 'Concept in Moneybird. Prijzen staan op 0 en moeten door een mens ingevuld en verstuurd worden.',
      antwoord: 'Ik heb de aanvraag klaargezet. Een van ons vult de prijs in en stuurt je vandaag nog de offerte.',
    });
  } catch (error) {
    const body = JSON.stringify((error as any)?.response?.data || {}).slice(0, 200);
    logger.error(`Bolletje offerte mislukt: ${body}`, error);
    res.status(500).json({ error: 'kon de offerte niet klaarzetten' });
  }
});
