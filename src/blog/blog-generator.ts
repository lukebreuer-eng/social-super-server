import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { cache } from '../config/redis';
import { logger } from '../utils/logger';
import { Bedrijf, ContentTemplate } from '../config/directus';

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// ============================================
// Types
// ============================================

export interface BlogGenerateInput {
  bedrijf: Bedrijf;
  keyword: string;
  topic?: string;
  targetWordCount?: number;
  templates: ContentTemplate[];
}

export interface GeneratedBlog {
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  metaTitle: string;
  metaDescription: string;
  tags: string[];
  headings: string[];
  wordCount: number;
  confidenceScore: number;
  promptUsed: string;
}

// ============================================
// System prompt for blog generation
// ============================================

function buildBlogSystemPrompt(bedrijf: Bedrijf): string {
  return `Je bent een expert SEO-copywriter voor het bedrijf "${bedrijf.title}".

BEDRIJFSINFORMATIE:
- Branche: ${bedrijf.branche}
- Beschrijving: ${bedrijf.description}
- Tone of Voice: ${bedrijf.tone_of_voice}
- Doelgroep: ${bedrijf.target_audience}
- USPs: ${bedrijf.unique_selling_points?.join(', ') || 'Niet opgegeven'}
- Content Pillars: ${bedrijf.content_pillars?.join(', ') || 'Niet opgegeven'}
- Website: ${bedrijf.website}

HUISSTIJL REGELS:
1. Schrijf ALTIJD in het Nederlands
2. Gebruik de tone of voice van het bedrijf CONSISTENT door het hele artikel
3. De eerste zin moet direct de aandacht pakken (hook)
4. Gebruik de USPs subtiel maar effectief
5. Schrijf voor de doelgroep — pas vocabulaire en diepgang aan
6. Elke sectie moet waarde bieden, geen opvulling
7. Gebruik korte alinea's (max 3-4 zinnen) voor leesbaarheid
8. Verwerk interne links naar de website waar relevant
9. Sluit altijd af met een duidelijke call-to-action
10. Gebruik emoji's spaarzaam en alleen waar het past bij de tone of voice

SEO REGELS:
1. Focus keyword moet in de eerste 100 woorden voorkomen
2. Focus keyword in minimaal 2 H2 headings
3. Keyword dichtheid: 1-2% (natuurlijk, niet geforceerd)
4. Gebruik LSI keywords (gerelateerde termen) door het artikel
5. Meta title: max 60 tekens, keyword vooraan
6. Meta description: 140-160 tekens met keyword en CTA
7. Minimaal 3 H2 headings, optioneel H3 subheadings
8. Alt-tekst suggesties voor afbeeldingen meegeven`;
}

// ============================================
// Blog generation
// ============================================

export async function generateBlog(input: BlogGenerateInput): Promise<GeneratedBlog> {
  const { bedrijf, keyword, topic, targetWordCount, templates } = input;

  // Check cache for recent blogs to avoid duplicates
  const cacheKey = `blog:${bedrijf.id}:titles`;
  const cached = await cache.get<string[]>(cacheKey);
  const recentTitles = cached || [];

  const wordCount = targetWordCount || 1000;

  // Pick a template if available
  const blogTemplates = templates.filter(t => t.platform === 'blog' || t.platform === 'all');
  const template = blogTemplates.length > 0
    ? blogTemplates[Math.floor(Math.random() * blogTemplates.length)]
    : null;

  const userPrompt = buildBlogUserPrompt(keyword, topic, wordCount, recentTitles, template, bedrijf);
  const systemPrompt = buildBlogSystemPrompt(bedrijf);

  logger.info(`Generating blog for ${bedrijf.title}: keyword="${keyword}"`);

  try {
    const response = await anthropic.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from AI');
    }

    const parsed = parseBlogResponse(textContent.text);

    // Cache title to avoid duplicates
    recentTitles.push(parsed.title);
    if (recentTitles.length > 10) recentTitles.shift();
    await cache.set(cacheKey, recentTitles, 30 * 24 * 3600); // 30 days

    logger.info(`Blog generated: "${parsed.title}" (${parsed.wordCount} words, confidence: ${parsed.confidenceScore})`);

    return {
      ...parsed,
      promptUsed: userPrompt.substring(0, 500),
    };
  } catch (error) {
    logger.error('Blog generation failed:', error);
    throw error;
  }
}

// ============================================
// User prompt builder
// ============================================

function buildBlogUserPrompt(
  keyword: string,
  topic: string | undefined,
  wordCount: number,
  recentTitles: string[],
  template: ContentTemplate | null,
  bedrijf: Bedrijf
): string {
  let prompt = '';

  if (template) {
    prompt = template.prompt_template;
    prompt += `\n\nFocus keyword: "${keyword}"`;
  } else {
    prompt = `Schrijf een SEO-geoptimaliseerd blogartikel over "${topic || keyword}" voor de website ${bedrijf.website}.

Focus keyword: "${keyword}"
Gewenste lengte: ${wordCount} woorden

Het artikel moet:
- Informatief en waardevol zijn voor de doelgroep
- Het bedrijf positioneren als expert in de branche
- Lezers aanmoedigen om actie te ondernemen (contact, offerte, aankoop)
- Goed scoren in Google op het focus keyword`;
  }

  if (recentTitles.length > 0) {
    prompt += `\n\nVERMIJD duplicatie met deze recente blogs:\n${recentTitles.map(t => `- ${t}`).join('\n')}`;
  }

  prompt += `\n\nGeef je antwoord in dit EXACTE JSON format:
{
  "title": "Blog titel (max 70 tekens, keyword erin)",
  "slug": "url-vriendelijke-slug",
  "excerpt": "Samenvatting in 1-2 zinnen voor preview (max 160 tekens)",
  "content": "Het volledige blogartikel in HTML format met <h2>, <h3>, <p>, <ul>, <li>, <strong>, <a> tags. Geen <h1> (dat is de titel). Minimaal 3 H2 secties.",
  "meta_title": "SEO titel (max 60 tekens, keyword vooraan)",
  "meta_description": "Meta description (140-160 tekens, keyword + CTA)",
  "tags": ["tag1", "tag2", "tag3"],
  "headings": ["H2 heading 1", "H2 heading 2", "H2 heading 3"],
  "confidence_score": 0.85
}`;

  return prompt;
}

// ============================================
// Response parser
// ============================================

function parseBlogResponse(text: string): GeneratedBlog {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in AI response');
    }

    const data = JSON.parse(jsonMatch[0]);

    const content = data.content || '';
    const wordCount = content.replace(/<[^>]*>/g, '').split(/\s+/).filter(Boolean).length;

    return {
      title: data.title || 'Untitled Blog',
      slug: data.slug || data.title?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'blog-post',
      excerpt: data.excerpt || '',
      content,
      metaTitle: data.meta_title || data.title || '',
      metaDescription: data.meta_description || data.excerpt || '',
      tags: data.tags || [],
      headings: data.headings || [],
      wordCount,
      confidenceScore: Math.min(1, Math.max(0, data.confidence_score || 0.7)),
      promptUsed: '',
    };
  } catch (error) {
    logger.error('Failed to parse blog AI response:', error);
    throw new Error('Failed to parse blog content from AI');
  }
}

logger.info('✅ Blog Generator initialized');
