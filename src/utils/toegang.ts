/**
 * Wie mag er iets in gang zetten dat geld kost of naar buiten gaat?
 *
 * De API-sleutel (env.API_KEY) staat niet overal ingesteld, en waar hij leeg is
 * laat de algemene middleware alles door. Voor lezen is dat te overzien, maar
 * niet voor handelingen die de centrale laten bellen: dat is andermans telefoon
 * en jouw rekening. Deze controle staat daarom los van die middleware en laat
 * niets door als er niets is ingesteld.
 *
 * Twee soorten bellers worden herkend. Een machine stuurt de API-sleutel mee.
 * Een mens in het dashboard stuurt zijn Directus-token mee; dat wordt bij
 * Directus zelf nagekeken, net als in /api/auth/me.
 */

import type { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Een token blijft even geldig in het geheugen, anders gaat er bij elke
 * dashboardpagina een reeks vragen naar Directus en wordt alles traag.
 */
const bekend = new Map<string, number>();
const GELDIG_MS = 60000;

async function geldigDirectusToken(token: string): Promise<boolean> {
  const tot = bekend.get(token);
  if (tot && tot > Date.now()) return true;
  try {
    await axios.get(`${env.DIRECTUS_URL}/users/me?fields=id`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 8000,
    });
    bekend.set(token, Date.now() + GELDIG_MS);
    if (bekend.size > 200) {
      for (const [sleutel, vervalt] of bekend) if (vervalt < Date.now()) bekend.delete(sleutel);
    }
    return true;
  } catch {
    return false;
  }
}

export async function mensOfMachine(req: Request): Promise<boolean> {
  const kop = req.headers.authorization || '';
  if (!kop.startsWith('Bearer ')) return false;
  const token = kop.slice(7).trim();
  if (!token) return false;
  if (env.API_KEY && token === env.API_KEY) return true;
  return geldigDirectusToken(token);
}

/** Zet dit voor alles wat de centrale laat bellen. */
export function alleenIngelogd(req: Request, res: Response, next: NextFunction): void {
  void mensOfMachine(req).then((mag) => {
    if (mag) return next();
    logger.warn(`Geweigerd zonder geldige toegang: ${req.method} ${req.originalUrl}`);
    res.status(401).json({ error: 'Log in of stuur een geldige API-sleutel mee' });
  });
}

/**
 * Rem op het inloggen.
 *
 * Het inlogformulier moet voor iedereen bereikbaar zijn, en daarmee ook voor
 * iemand die wachtwoorden zit te raden. Tien pogingen per kwartier per adres is
 * ruim voor een mens die zich vergist en te weinig om iets mee te vinden.
 */
const pogingen = new Map<string, { aantal: number; tot: number }>();
const VENSTER_MS = 900000;
const MAXIMAAL = 10;

export function remOpInloggen(req: Request, res: Response, next: NextFunction): void {
  const adres = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'onbekend';
  const nu = Date.now();
  const staat = pogingen.get(adres);

  if (!staat || staat.tot < nu) {
    pogingen.set(adres, { aantal: 1, tot: nu + VENSTER_MS });
  } else if (staat.aantal >= MAXIMAAL) {
    logger.warn(`Te veel inlogpogingen vanaf ${adres}`);
    res.status(429).json({ errors: [{ message: 'Te veel inlogpogingen. Probeer het over een kwartier opnieuw.' }] });
    return;
  } else {
    staat.aantal += 1;
  }

  if (pogingen.size > 1000) {
    for (const [sleutel, waarde] of pogingen) if (waarde.tot < nu) pogingen.delete(sleutel);
  }
  next();
}

/**
 * Wie mag wat binnen het dashboard?
 *
 * Inloggen is niet genoeg voor alles. Een collega van IPVG hoort de omzet en
 * de gebruikerslijst niet te zien, en ook geen gegevens van een ander bedrijf.
 * Het dashboard verbergt die menu's al, maar dat gebeurt in de browser en is
 * dus geen afscherming. Hier staat dezelfde indeling nog een keer, nu op de
 * server.
 *
 * Een beheerder (rol met admin in de naam, of de API-sleutel) mag alles.
 */
const RECHTEN: Record<string, { bedrijven: number[]; omzet: boolean }> = {
  'tarek@ipvoicegroup.nl': { bedrijven: [5], omzet: false },
  'cisca@ipvoicegroup.nl': { bedrijven: [7], omzet: true },
  'levi@ijsuitdepolder.nl': { bedrijven: [7], omzet: true },
  'hoflandlevi@gmail.com': { bedrijven: [7], omzet: true },
  'jools@ipvoicegroup.nl': { bedrijven: [6], omzet: false },
};

export interface Gebruiker { beheerder: boolean; email: string; bedrijven: number[]; omzet: boolean }

const wie = new Map<string, { g: Gebruiker; tot: number }>();

export async function wieIsHet(req: Request): Promise<Gebruiker | null> {
  const kop = req.headers.authorization || '';
  if (!kop.startsWith('Bearer ')) return null;
  const token = kop.slice(7).trim();
  if (!token) return null;
  if (env.API_KEY && token === env.API_KEY) return { beheerder: true, email: 'api', bedrijven: [], omzet: true };
  const bewaard = wie.get(token);
  if (bewaard && bewaard.tot > Date.now()) return bewaard.g;
  try {
    const r = await axios.get(`${env.DIRECTUS_URL}/users/me?fields=email,role.name`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 8000,
    });
    const d = r.data?.data || {};
    const email = String(d.email || '').toLowerCase();
    const beheerder = String(d.role?.name || '').toLowerCase().includes('admin');
    const recht = RECHTEN[email] || { bedrijven: [], omzet: false };
    const g: Gebruiker = { beheerder, email, bedrijven: recht.bedrijven, omzet: recht.omzet };
    wie.set(token, { g, tot: Date.now() + GELDIG_MS });
    if (wie.size > 200) for (const [k, v] of wie) if (v.tot < Date.now()) wie.delete(k);
    return g;
  } catch {
    return null;
  }
}

/** Alleen voor beheerders, zoals de gebruikerslijst en wachtwoorden resetten. */
export function alleenBeheerder(req: Request, res: Response, next: NextFunction): void {
  void wieIsHet(req).then((g) => {
    if (g?.beheerder) return next();
    logger.warn(`Alleen voor beheerders, geweigerd: ${req.method} ${req.originalUrl} (${g?.email || 'onbekend'})`);
    res.status(403).json({ error: 'Alleen voor beheerders' });
  });
}

/**
 * Omzet en opvolging. Opvolgen (de Sales-pagina) mag iedereen voor zijn eigen
 * bedrijf; de rest van de omzetcijfers alleen wie daar recht op heeft.
 */
export function omzetToegang(req: Request, res: Response, next: NextFunction): void {
  void wieIsHet(req).then((g) => {
    if (!g) { res.status(401).json({ error: 'Log in' }); return; }
    if (g.beheerder) return next();
    const pad = req.path;
    const opvolgLijst = pad.match(/^\/(\d+)\/opvolg$/);
    if (opvolgLijst) {
      if (g.bedrijven.includes(Number(opvolgLijst[1]))) return next();
    } else if (/^\/opvolg\/\d+\/(opruimen|draft)$/.test(pad)) {
      if (g.bedrijven.length) return next();
    } else if (g.omzet) {
      const nummer = pad.match(/\/(\d+)(?:\/|$)/);
      if (nummer && g.bedrijven.includes(Number(nummer[1]))) return next();
    }
    logger.warn(`Geen recht op omzet: ${req.method} ${req.originalUrl} (${g.email})`);
    res.status(403).json({ error: 'Geen toegang tot deze gegevens' });
  });
}
