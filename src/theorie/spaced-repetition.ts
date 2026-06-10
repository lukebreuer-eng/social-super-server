import { readItems } from '@directus/sdk';
import { directus } from '../config/directus';

interface VraagWithStats {
  id: number;
  categorie: string;
  sub_onderwerp: string | null;
  keer_getoond: number;
  keer_correct: number;
  miles_correct: number;
  miles_attempts: number;
  laatste_poging: string | null;
}

/**
 * Selecteer de volgende vraag op basis van een eenvoudige spaced-repetition score.
 *
 * - Vragen die nog NOOIT gemaakt zijn: hoogste prioriteit
 * - Vragen die FOUT waren: hogere prioriteit
 * - Vragen die LANG GELEDEN goed waren: lagere prioriteit (komen terug om in te slijpen)
 * - Vragen die net goed waren: laagste prioriteit (zit erin)
 */
export async function selecteerVolgendeVraag(
  gebruiker: string,
  categorie?: string,
  excludeIds: number[] = [],
): Promise<{ id: number; categorie: string; reason: string } | null> {
  const filter: Record<string, unknown> = { status: { _eq: 'active' } };
  if (categorie && categorie !== 'mix') {
    filter.categorie = { _eq: categorie };
  }

  const vragen = await directus.request(
    readItems('Theorie_Vragen', {
      filter,
      fields: ['id', 'categorie', 'sub_onderwerp'] as any,
      limit: 200,
    }),
  ) as Array<{ id: number; categorie: string; sub_onderwerp: string }>;

  if (vragen.length === 0) return null;

  // Pogingen van deze gebruiker ophalen
  const pogingen = await directus.request(
    readItems('Theorie_Pogingen', {
      filter: { gebruiker: { _eq: gebruiker } } as any,
      fields: ['vraag', 'correct', 'date_created'] as any,
      sort: ['-date_created'] as any,
      limit: 1000,
    }),
  ) as Array<{ vraag: number; correct: boolean; date_created: string }>;

  const statsPerVraag = new Map<number, { attempts: number; correct: number; lastAt: string | null; lastCorrect: boolean | null }>();
  for (const p of pogingen) {
    const s = statsPerVraag.get(p.vraag) || { attempts: 0, correct: 0, lastAt: null, lastCorrect: null };
    s.attempts += 1;
    if (p.correct) s.correct += 1;
    if (!s.lastAt) {
      s.lastAt = p.date_created;
      s.lastCorrect = p.correct;
    }
    statsPerVraag.set(p.vraag, s);
  }

  type Scored = { id: number; categorie: string; score: number; reason: string };
  const now = Date.now();
  const scored: Scored[] = vragen
    .filter((v) => !excludeIds.includes(v.id))
    .map((v) => {
      const s = statsPerVraag.get(v.id);
      let score = 0;
      let reason = '';

      if (!s) {
        // Nooit eerder gemaakt — hoogste prio
        score = 100;
        reason = 'nooit_gedaan';
      } else if (s.lastCorrect === false) {
        // Laatste keer fout — herhalen
        score = 80;
        reason = 'laatst_fout';
      } else {
        const hoursAgo = s.lastAt ? (now - new Date(s.lastAt).getTime()) / 3600000 : 9999;
        const correctRatio = s.attempts > 0 ? s.correct / s.attempts : 0;
        // Hoe lager de ratio, hoe vaker herhalen
        const ratioBonus = (1 - correctRatio) * 40;
        // Hoe langer geleden, hoe meer prio
        const timeBonus = Math.min(40, hoursAgo / 6);
        score = ratioBonus + timeBonus;
        reason = `ratio=${correctRatio.toFixed(2)} hours=${hoursAgo.toFixed(0)}`;
      }

      return { id: v.id, categorie: v.categorie, score: score + Math.random() * 5, reason };
    });

  scored.sort((a, b) => b.score - a.score);
  const pick = scored[0];
  if (!pick) return null;
  return { id: pick.id, categorie: pick.categorie, reason: pick.reason };
}
