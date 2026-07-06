import Anthropic from '@anthropic-ai/sdk';
import { readItems } from '@directus/sdk';
import { directus, db, Bedrijf } from '../config/directus';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export type EmailCategory =
  | 'booking'
  | 'pricing'
  | 'availability'
  | 'info'
  | 'complaint'
  | 'cancellation'
  | 'invoice'
  | 'spam'
  | 'other';

export type EmailPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface ClassificationResult {
  category: EmailCategory;
  priority: EmailPriority;
  summary: string;
  customerSentiment: 'positive' | 'neutral' | 'negative';
  needsHuman: boolean;
  reasoning: string;
}

export interface ReplyDraft {
  subject: string;
  bodyPlain: string;
  bodyHtml: string;
  category: EmailCategory;
  priority: EmailPriority;
  shouldAutoSend: boolean;
  confidence: number;
  reasoning: string;
  summary: string;
}

interface EmailContext {
  fromEmail: string;
  fromName: string;
  subject: string;
  bodyPlain: string;
  receivedAt: Date;
  threadHistory?: Array<{ direction: 'inbound' | 'outbound'; subject: string; body: string; at: string }>;
}

/**
 * Stap 1: Classificeer + analyseer de mail.
 * Stap 2: Genereer concept reply met brand voice + knowledge base.
 * Stap 3: Beslis op basis van categorie of de reply auto verstuurd mag worden.
 */
export async function generateEmailReply(
  bedrijfId: number,
  ctx: EmailContext,
): Promise<ReplyDraft> {
  const bedrijf = await db.getBedrijf(bedrijfId);
  if (!bedrijf) throw new Error(`Bedrijf ${bedrijfId} not found`);

  const knowledgeEntries = await fetchKnowledgeBase(bedrijfId);
  const classification = await classifyEmail(ctx);

  // Planning-beschikbaarheid meegeven zodat het antwoord op datumvragen klopt.
  let beschikbaarheid = '';
  try { const { getBeschikbaarheidTekst } = await import('../agents/beschikbaarheid'); beschikbaarheid = await getBeschikbaarheidTekst(bedrijfId); }
  catch { /* geen planning-context beschikbaar */ }

  const { subject, bodyPlain, bodyHtml, confidence } = await composeReply(
    bedrijf,
    ctx,
    classification,
    knowledgeEntries,
    beschikbaarheid,
  );

  const shouldAutoSend = decideAutoSend(classification, confidence);

  return {
    subject,
    bodyPlain,
    bodyHtml,
    category: classification.category,
    priority: classification.priority,
    shouldAutoSend,
    confidence,
    reasoning: classification.reasoning,
    summary: classification.summary,
  };
}

async function classifyEmail(ctx: EmailContext): Promise<ClassificationResult> {
  const systemPrompt = `Je bent een mail-triage assistent voor "IJs uit de Polder", een ijscatering bedrijf uit Flevoland (Bedford ijswagen, gelatobar, ijsscooter voor bruiloften, bedrijfsfeesten, kinderfeesten). Je krijgt een binnenkomende klantmail en classificeert deze.

Antwoord uitsluitend met geldige JSON in dit schema:
{
  "category": "booking" | "pricing" | "availability" | "info" | "complaint" | "cancellation" | "invoice" | "spam" | "other",
  "priority": "low" | "normal" | "high" | "urgent",
  "summary": "1 zin in Nederlands wat de klant wil",
  "customerSentiment": "positive" | "neutral" | "negative",
  "needsHuman": true | false,
  "reasoning": "1-2 zinnen waarom deze categorie en of een mens moet ingrijpen"
}

Richtlijnen:
- "booking" = concrete aanvraag voor een datum (bv. "kunnen jullie 15 juni leveren?")
- "availability" = vraag of een datum nog kan, zonder firm boeken
- "pricing" = vraag naar prijzen, offerte zonder concrete datum
- "info" = algemene vraag (smaken, dieet, opstelling, vegan, glutenvrij)
- "complaint" = ontevredenheid → needsHuman=true, priority="high"
- "cancellation" → needsHuman=true
- "invoice" = factuur, betaling, BTW → needsHuman=true
- "spam" = nieuwsbrief, marketing aanbod aan ons → needsHuman=false, doe niets
- needsHuman=true bij: klacht, annulering, factuur, juridisch, complexe of unieke vraag, agressieve toon`;

  const userPrompt = `Van: ${ctx.fromName ? `${ctx.fromName} <${ctx.fromEmail}>` : ctx.fromEmail}
Onderwerp: ${ctx.subject}
Ontvangen: ${ctx.receivedAt.toISOString()}

${ctx.bodyPlain.slice(0, 4000)}`;

  const response = await anthropic.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 600,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  try { const { logVerbruik } = await import('./usage'); logVerbruik('mail', env.ANTHROPIC_MODEL, (response as any).usage); } catch (e) {}
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');

  const json = extractJson(text);
  return json as ClassificationResult;
}

async function composeReply(
  bedrijf: Bedrijf,
  ctx: EmailContext,
  classification: ClassificationResult,
  knowledgeEntries: Array<{ title: string; content: string; category: string }>,
  beschikbaarheid = '',
): Promise<{ subject: string; bodyPlain: string; bodyHtml: string; confidence: number }> {
  const signaturePlain = env.IJS_SIGNATURE || buildDefaultSignature(bedrijf);
  const signatureHtml = env.IJS_SIGNATURE_HTML || `<p>${signaturePlain.replace(/\n/g, '<br>')}</p>`;

  const knowledge = knowledgeEntries
    .slice(0, 20)
    .map((k) => `### ${k.title}\n${k.content}`)
    .join('\n\n');

  const systemPrompt = `Je bent de digitale assistent van "${bedrijf.title}". Je beantwoordt klantmails namens het bedrijf in vlot, warm en informeel Nederlands. Geen marketing-taal, geen overdreven uitroeptekens. Schrijf zoals een vriendelijke ondernemer die zelf reageert.

BEDRIJF
${bedrijf.description || ''}

TONE OF VOICE
${bedrijf.tone_of_voice || 'Informeel, warm, persoonlijk, Vlaams-Nederlands, kort en concreet, geen jargon, lichte humor mag.'}

USP's
${(bedrijf.unique_selling_points || []).map((u: string) => `- ${u}`).join('\n')}

WEBSITE
${bedrijf.website || ''}

KENNISBANK (gebruik wat relevant is, verzin niets)
${knowledge || '(nog geen kennisbank entries)'}

PLANNING / BESCHIKBAARHEID (actueel, uit onze eigen planning)
${beschikbaarheid || '(planning niet beschikbaar)'}

REGELS
- Vraagt de klant naar een specifieke datum? Kijk EERST in de PLANNING / BESCHIKBAARHEID hierboven. Zit die dag vol of is er een conflict (bv. de ijskraam of ijswagen kan er niet meer bij omdat Luke/Levi al rijdt), zeg dat dan eerlijk en concreet ("op donderdag 9 juli zit de ijswagen helaas al vol") en bied waar mogelijk een alternatief of stel voor dat we meedenken. Doe geen harde toezegging dat het KAN zonder dat het uit de planning blijkt; bevestig dat de eigenaar het definitief vastlegt.
- Beantwoord ALLEEN op basis van bovenstaande info. Verzin geen prijzen, data, beschikbaarheid of beloftes.
- KRITISCH — NOOIT zelf getallen of feiten verzinnen die niet LETTERLIJK in de bedrijfsinfo, USP's of kennisbank hierboven staan. Dus geen "30 smaken", "2-3 bollen per persoon", "binnen 50km", "vanaf €X", aantallen wagens, openingstijden, levertijden, capaciteiten — tenzij dat exacte getal of feit één-op-één in de tekst hierboven staat. Bij twijfel: schrijf het algemener ("ruime smakenkeuze", "indicatieve hoeveelheid op offerte") of zeg dat een collega het exact terugkoppelt.
- Mag je iets niet zeker zeggen → schrijf dat een collega er nog even naar kijkt en uiterlijk de volgende werkdag terugkomt.
- BELANGRIJK — Geen afsluiting schrijven. Stop direct na de laatste informatieve zin van je antwoord. Schrijf GEEN "Groetjes", "Groet", "Met vriendelijke groet", "Hartelijke groet", "Tot snel", "Veel succes", "Tot ziens", "Mvg", geen naam, geen contactgegevens. De afsluiting + handtekening worden automatisch onderaan toegevoegd — als jij er ook eentje schrijft krijgt de klant een dubbele afsluiting.
- Geen aanhef "Geachte heer/mevrouw". Gebruik de voornaam van de klant als je die kan halen uit het mailadres of bericht, anders "Hoi" zonder naam.
- 80-180 woorden, tenzij de vraag echt korter of langer rechtvaardigt.
- Schrijf alsof Levi of Luke het zelf typt.

CONFIDENCE-RICHTLIJN (bij twijfel altijd lager scoren)
- Als je een getal of feit nodig had dat NIET letterlijk in de info hierboven stond → confidence MAX 0.6 (gaat naar review, niet auto-verzonden).
- Als de klant om een offerte/prijs vraagt en je hebt geen concrete prijs → confidence MAX 0.7.
- Als de klant een complexe situatie schetst (allergieën, ongewone locatie, korte termijn) → confidence MAX 0.6.
- Alleen confidence 0.85+ als ALLE getallen en feiten in je antwoord rechtstreeks uit de kennisbank/bedrijfsinfo komen EN de vraag standaard FAQ-niveau is.

Geef je antwoord als JSON:
{
  "subject": "Re: ...",
  "bodyPlain": "tekst-versie",
  "bodyHtml": "HTML-versie met <p>-tags",
  "confidence": 0.0 tot 1.0
}

confidence is hoe zeker je bent dat dit een goed antwoord is dat ZONDER review verstuurd kan worden.
- 0.9+ : standaard FAQ-vraag waar je een 100% antwoord op hebt uit de kennisbank
- 0.7-0.89 : redelijk standaard, maar bevat aannames
- 0.5-0.69 : antwoord raakt aan onbekend terrein
- < 0.5 : laat een mens kijken`;

  const threadContext = ctx.threadHistory && ctx.threadHistory.length > 0
    ? `\n\nEERDER IN DE THREAD:\n${ctx.threadHistory.slice(-4).map((m) => `[${m.direction}] ${m.at}: ${m.body.slice(0, 500)}`).join('\n\n')}\n`
    : '';

  const userPrompt = `KLASSIFICATIE
Categorie: ${classification.category}
Samenvatting: ${classification.summary}
Sentiment: ${classification.customerSentiment}
${threadContext}

INKOMENDE MAIL
Van: ${ctx.fromName ? `${ctx.fromName} <${ctx.fromEmail}>` : ctx.fromEmail}
Onderwerp: ${ctx.subject}
Ontvangen: ${ctx.receivedAt.toISOString()}

${ctx.bodyPlain.slice(0, 6000)}

Schrijf nu het concept antwoord.`;

  const response = await anthropic.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  try { const { logVerbruik } = await import('./usage'); logVerbruik('mail', env.ANTHROPIC_MODEL, (response as any).usage); } catch (e) {}
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');

  const parsed = extractJson(text) as {
    subject: string;
    bodyPlain: string;
    bodyHtml: string;
    confidence: number;
  };

  const fullPlain = `${parsed.bodyPlain.trim()}\n\n${signaturePlain}`;
  const fullHtml = `${parsed.bodyHtml || ''}\n${signatureHtml}`;

  return {
    subject: ensureRePrefix(parsed.subject || ctx.subject),
    bodyPlain: fullPlain,
    bodyHtml: fullHtml,
    confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
  };
}

function decideAutoSend(classification: ClassificationResult, confidence: number): boolean {
  const mode = env.IJS_REPLY_AUTO_SEND;
  if (mode === 'never') return false;
  if (mode === 'always') return !classification.needsHuman;

  // hybrid (default)
  if (classification.needsHuman) return false;
  if (classification.priority === 'urgent' || classification.priority === 'high') return false;

  const allowed = env.IJS_REPLY_AUTO_CATEGORIES.split(',').map((s) => s.trim());
  if (!allowed.includes(classification.category)) return false;

  return confidence >= 0.85;
}

async function fetchKnowledgeBase(bedrijfId: number): Promise<Array<{ title: string; content: string; category: string }>> {
  try {
    const entries = await directus.request(
      readItems('AI_Knowledge_Base', {
        filter: { bedrijf: { _eq: bedrijfId } } as any,
        limit: 100,
      }),
    ) as any[];
    return entries.map((e) => ({
      title: e.title || e.name || '',
      content: e.content || e.body || e.text || '',
      category: e.category || e.type || '',
    }));
  } catch (err) {
    logger.warn('Could not fetch AI_Knowledge_Base for email agent:', err);
    return [];
  }
}

function buildDefaultSignature(bedrijf: Bedrijf): string {
  return `Hartelijke groet,
\nHet team van ${bedrijf.title}\n${bedrijf.website || ''}`;
}

function ensureRePrefix(subject: string): string {
  if (!subject) return 'Re: (geen onderwerp)';
  return /^re:\s/i.test(subject) ? subject : `Re: ${subject}`;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  const candidate = fenced ? fenced[1] : text;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('AI response bevatte geen JSON object');
  }
  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}
