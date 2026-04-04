import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { cache } from '../config/redis';
import { logger } from '../utils/logger';
import { Bedrijf, ContentTemplate } from '../config/directus';

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// ============================================
// Types
// ============================================

interface GenerateContentInput {
  bedrijf: Bedrijf;
  platform: string;
  postType: string;
  templates: ContentTemplate[];
  customPrompt?: string;
}

interface GeneratedContent {
  title: string;
  caption: string;
  hashtags: string[];
  ctaLink: string;
  ctaText: string;
  promptUsed: string;
  confidenceScore: number;
  suggestedVisual: string;
}

interface PlatformConstraints {
  maxLength: number;
  hashtagLimit: number;
  tone: string;
  features: string[];
}

// ============================================
// Platform-specific constraints
// ============================================

const PLATFORM_CONSTRAINTS: Record<string, PlatformConstraints> = {
  instagram: {
    maxLength: 2200,
    hashtagLimit: 30,
    tone: 'visueel, persoonlijk, inspirerend',
    features: ['carousel', 'reel', 'story', 'single_image'],
  },
  facebook: {
    maxLength: 63206,
    hashtagLimit: 10,
    tone: 'informatief, community-gericht, conversationeel',
    features: ['link_post', 'image', 'video', 'carousel'],
  },
  linkedin: {
    maxLength: 3000,
    hashtagLimit: 5,
    tone: 'professioneel, thought-leadership, zakelijk',
    features: ['article', 'document', 'image', 'video'],
  },
  tiktok: {
    maxLength: 2200,
    hashtagLimit: 15,
    tone: 'casual, trending, entertaining, educatief',
    features: ['video', 'photo_carousel'],
  },
};

// ============================================
// System prompt builder
// ============================================

function buildSystemPrompt(bedrijf: Bedrijf, platform: string): string {
  const constraints = PLATFORM_CONSTRAINTS[platform] || PLATFORM_CONSTRAINTS.instagram;

  return `Je bent een expert social media content creator voor het bedrijf "${bedrijf.title}".

BEDRIJFSINFORMATIE:
- Branche: ${bedrijf.branche}
- Beschrijving: ${bedrijf.description}
- Tone of Voice: ${bedrijf.tone_of_voice}
- Doelgroep: ${bedrijf.target_audience}
- USPs: ${bedrijf.unique_selling_points?.join(', ') || 'Niet opgegeven'}
- Content Pillars: ${bedrijf.content_pillars?.join(', ') || 'Niet opgegeven'}
- Website: ${bedrijf.website}

PLATFORM: ${platform.toUpperCase()}
- Max caption lengte: ${constraints.maxLength} tekens
- Max hashtags: ${constraints.hashtagLimit}
- Tone: ${constraints.tone}
- Content formats: ${constraints.features.join(', ')}

REGELS:
1. Schrijf ALTIJD in het Nederlands tenzij anders gevraagd
2. De content moet authentiek aanvoelen, niet als AI-gegenereerd
3. Gebruik de tone of voice van het bedrijf consistent
4. Voeg altijd een duidelijke call-to-action toe
5. Hashtags moeten relevant zijn voor de branche en doelgroep
6. Focus op waarde voor de doelgroep, niet alleen promotie
7. Wissel af tussen educatief, inspirerend, en promotioneel
8. Gebruik emoji's spaarzaam maar effectief
9. Hook de lezer in de eerste zin

BELANGRIJK: Genereer content die leads en conversie stimuleert.`;
}

// ============================================
// Content generation
// ============================================

export async function generateContent(input: GenerateContentInput): Promise<GeneratedContent> {
  const { bedrijf, platform, postType, templates, customPrompt } = input;

  // Check cache for recent generation to avoid duplicates
  const cacheKey = `content:${bedrijf.id}:${platform}:${postType}`;
  const cached = await cache.get<string[]>(cacheKey);
  const recentTitles = cached || [];

  // Pick a template if available
  const template = templates.length > 0
    ? templates[Math.floor(Math.random() * templates.length)]
    : null;

  const userPrompt = customPrompt || buildUserPrompt(postType, template, recentTitles);
  const systemPrompt = buildSystemPrompt(bedrijf, platform);

  logger.info(`Generating ${postType} content for ${bedrijf.title} on ${platform}`);

  try {
    const response = await anthropic.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    });

    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from AI');
    }

    const parsed = parseAIResponse(textContent.text, platform);

    // Cache this title to avoid duplicates in next generations
    recentTitles.push(parsed.title);
    if (recentTitles.length > 20) recentTitles.shift();
    await cache.set(cacheKey, recentTitles, 7 * 24 * 3600); // 7 days

    logger.info(`Content generated: "${parsed.title}" (confidence: ${parsed.confidenceScore})`);

    return {
      ...parsed,
      promptUsed: userPrompt.substring(0, 500),
    };
  } catch (error) {
    logger.error('AI content generation failed:', error);
    throw error;
  }
}

// ============================================
// User prompt builder
// ============================================

function buildUserPrompt(
  postType: string,
  template: ContentTemplate | null,
  recentTitles: string[]
): string {
  let prompt = '';

  if (template) {
    prompt = template.prompt_template;
  } else {
    switch (postType) {
      case 'educational':
        prompt = `Maak een educatieve post die waardevolle kennis deelt met de doelgroep.
        Focus op een tip, how-to, of interessant feit uit de branche.`;
        break;
      case 'promotional':
        prompt = `Maak een promotionele post die een product of dienst onder de aandacht brengt.
        Focus op de voordelen voor de klant en voeg een sterke CTA toe.`;
        break;
      case 'engagement':
        prompt = `Maak een engagement post die reacties en interactie stimuleert.
        Stel een vraag, deel een poll-idee, of nodig uit tot discussie.`;
        break;
      case 'behind_the_scenes':
        prompt = `Maak een behind-the-scenes post die het menselijke gezicht van het bedrijf laat zien.
        Deel iets over het team, het proces, of de bedrijfscultuur.`;
        break;
      case 'testimonial':
        prompt = `Maak een post gebaseerd op een klantverhaal of testimonial format.
        Gebruik een herkenbaar probleem + oplossing structuur.`;
        break;
      default:
        prompt = `Maak een sterke social media post die past bij het merk en de doelgroep aanspreekt.
        Zorg voor een goede mix van waarde en promotie.`;
    }
  }

  if (recentTitles.length > 0) {
    prompt += `\n\nVERMIJD duplicatie met deze recente posts:\n${recentTitles.map(t => `- ${t}`).join('\n')}`;
  }

  prompt += `\n\nGeef je antwoord in dit EXACTE JSON format:
{
  "title": "Korte interne titel voor de post",
  "caption": "De volledige caption/tekst voor de post",
  "hashtags": ["hashtag1", "hashtag2"],
  "cta_link": "https://relevante-link.nl",
  "cta_text": "Tekst voor de call-to-action",
  "suggested_visual": "Beschrijving van het ideale visuele element",
  "confidence_score": 0.85
}`;

  return prompt;
}

// ============================================
// Response parser
// ============================================

function parseAIResponse(text: string, platform: string): GeneratedContent {
  const constraints = PLATFORM_CONSTRAINTS[platform] || PLATFORM_CONSTRAINTS.instagram;

  try {
    // Extract JSON from response (AI might wrap it in markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in AI response');
    }

    const data = JSON.parse(jsonMatch[0]);

    // Validate and enforce constraints
    let caption = data.caption || '';
    if (caption.length > constraints.maxLength) {
      caption = caption.substring(0, constraints.maxLength - 3) + '...';
    }

    let hashtags: string[] = data.hashtags || [];
    if (hashtags.length > constraints.hashtagLimit) {
      hashtags = hashtags.slice(0, constraints.hashtagLimit);
    }
    // Ensure hashtags start with #
    hashtags = hashtags.map((tag: string) => tag.startsWith('#') ? tag : `#${tag}`);

    return {
      title: data.title || 'Untitled Post',
      caption,
      hashtags,
      ctaLink: data.cta_link || '',
      ctaText: data.cta_text || '',
      suggestedVisual: data.suggested_visual || '',
      confidenceScore: Math.min(1, Math.max(0, data.confidence_score || 0.7)),
      promptUsed: '',
    };
  } catch (error) {
    logger.error('Failed to parse AI response, using fallback:', error);

    // Fallback: treat entire response as caption
    return {
      title: 'AI Generated Post',
      caption: text.substring(0, constraints.maxLength),
      hashtags: [],
      ctaLink: '',
      ctaText: '',
      suggestedVisual: '',
      confidenceScore: 0.5,
      promptUsed: '',
    };
  }
}

// ============================================
// Bulk content generation for a week
// ============================================

export async function generateWeeklyContent(
  bedrijfId: number,
  platform: string,
  postsPerWeek: number
): Promise<GeneratedContent[]> {
  const { db: database } = await import('../config/directus');
  const bedrijf = await database.getBedrijf(bedrijfId);
  const templates = await database.getTemplates(bedrijfId, platform);

  const postTypes = ['educational', 'promotional', 'engagement', 'behind_the_scenes', 'testimonial'];
  const results: GeneratedContent[] = [];

  for (let i = 0; i < postsPerWeek; i++) {
    const postType = postTypes[i % postTypes.length];

    // Rate limit: wait 2 seconds between API calls
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const content = await generateContent({
      bedrijf,
      platform,
      postType,
      templates,
    });

    results.push(content);
  }

  logger.info(`Generated ${results.length} posts for ${bedrijf.title} on ${platform}`);
  return results;
}

logger.info('✅ AI Content Generator initialized');
