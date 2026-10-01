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
