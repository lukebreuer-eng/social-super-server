/**
 * Welke Moneybird-administratie hoort bij welk bedrijf.
 *
 * IJs (7) en IP Voice Group (5) hebben elk een eigen administratie en een eigen
 * token. Ontbreekt het token van een bedrijf, dan geeft dit null en slaat de
 * sync dat bedrijf over.
 */
import { env } from '../config/env';

export interface MoneybirdToegang { token: string; admin: string }

export function moneybirdVoor(bedrijfId: number): MoneybirdToegang | null {
  if (bedrijfId === 7) {
    return env.IJS_MONEYBIRD_API_TOKEN
      ? { token: env.IJS_MONEYBIRD_API_TOKEN, admin: env.IJS_MONEYBIRD_ADMINISTRATION_ID || '299278260688127925' }
      : null;
  }
  if (bedrijfId === 5) {
    return env.IPVG_MONEYBIRD_API_TOKEN && env.IPVG_MONEYBIRD_ADMINISTRATION_ID
      ? { token: env.IPVG_MONEYBIRD_API_TOKEN, admin: env.IPVG_MONEYBIRD_ADMINISTRATION_ID }
      : null;
  }
  return null;
}
