import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// ============================================
// reCAPTCHA v3 verificatie voor lead capture
// ============================================
//
// IPVG anti-spam v2 (18-07-2026). De bot postte rechtstreeks op POST /api/leads.
// v1 gebruikte een statisch token in de frontend-JS; dat las de bot uit de bron en
// hergebruikte hij. v3-verificatie kan hij niet namaken: hij heeft geen browser.
//
// De frontend (mu-plugin ipvg-lead-token.php op WordPress) haalt per submit een vers
// token op met grecaptcha.execute() en stuurt dat mee als X-Recaptcha-Token.
//
// Fail-closed: geen token, geen secret of een fout bij Google → 403.

const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

interface SiteverifyResponse {
  success?: boolean;
  score?: number;
  action?: string;
  'error-codes'?: string[];
}

export async function verifyRecaptcha(req: Request, res: Response, next: NextFunction) {
  if (!env.RECAPTCHA_SECRET) {
    logger.error('RECAPTCHA_SECRET ontbreekt — lead capture geweigerd (fail-closed)');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const token = req.headers['x-recaptcha-token'];
  if (typeof token !== 'string' || !token) {
    logger.warn('Lead capture zonder reCAPTCHA-token geweigerd');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const minScore = Number(env.RECAPTCHA_MIN_SCORE) || 0.5;

  try {
    const response = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${encodeURIComponent(env.RECAPTCHA_SECRET)}&response=${encodeURIComponent(token)}`,
    });
    const data = (await response.json()) as SiteverifyResponse;

    if (!data.success) {
      logger.warn(`Lead capture geweigerd: reCAPTCHA ongeldig (${(data['error-codes'] || []).join(', ')})`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (typeof data.score === 'number' && data.score < minScore) {
      logger.warn(`Lead capture geweigerd: reCAPTCHA-score ${data.score} < ${minScore}`);
      return res.status(403).json({ error: 'Forbidden' });
    }
  } catch (error) {
    logger.error('reCAPTCHA-verificatie mislukt:', error);
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
}
