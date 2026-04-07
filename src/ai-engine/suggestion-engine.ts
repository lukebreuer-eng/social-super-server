import { directus } from '../config/directus';
import { readItems, createItem, updateItem } from '@directus/sdk';
import { logger } from '../utils/logger';

// ============================================
// Types
// ============================================

interface Suggestion {
  bedrijf: number;
  suggestion_type: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  confidence: number;
  data_basis: Record<string, unknown>;
  related_post?: number;
}

// ============================================
// Generate AI Suggestions for a bedrijf
// ============================================

export async function generateSuggestions(bedrijfId: number): Promise<{ created: number }> {
  const suggestions: Suggestion[] = [];

  // Get bedrijf info
  const bedrijven = await directus.request(
    readItems('Bedrijven', { filter: { id: { _eq: bedrijfId } }, limit: 1 })
  ) as Array<{ id: number; title: string; posting_goals: Record<string, { per_week: number }> }>;

  if (!bedrijven.length) return { created: 0 };
  const bedrijf = bedrijven[0];

  // Get recent posts
  const posts = await directus.request(
    readItems('Posts', {
      filter: { bedrijf: { _eq: bedrijfId } },
      sort: ['-date_created'],
      limit: 50,
    })
  ) as Array<{
    id: number; title: string; post_type: string; approval_status: string;
    published_at: string | null; engagement_likes: number; engagement_comments: number;
    engagement_shares: number; engagement_reach: number; engagement_score: number;
    seo_score: number; blog_views: number; date_created: string;
  }>;

  // Get existing suggestions to avoid duplicates
  const existing = await directus.request(
    readItems('AI_Suggestions', {
      filter: { bedrijf: { _eq: bedrijfId }, status: { _in: ['new', 'viewed'] } },
      fields: ['title'],
    })
  ) as Array<{ title: string }>;
  const existingTitles = new Set(existing.map(s => s.title.toLowerCase()));

  const published = posts.filter(p => p.published_at);
  const pending = posts.filter(p => p.approval_status === 'pending_review');
  const blogs = posts.filter(p => p.post_type === 'blog');

  // ============================================
  // Rule 1: Boost high-performing posts
  // ============================================
  for (const post of published) {
    const totalEngagement = post.engagement_likes + post.engagement_comments + post.engagement_shares;
    if (totalEngagement > 10 && post.engagement_reach > 100) {
      const title = `Boost: "${post.title.substring(0, 50)}" presteert goed`;
      if (!existingTitles.has(title.toLowerCase())) {
        suggestions.push({
          bedrijf: bedrijfId,
          suggestion_type: 'boost_post',
          title,
          description: `Deze post heeft ${totalEngagement} interacties en ${post.engagement_reach} bereik. Overweeg een boost om meer mensen te bereiken.`,
          priority: 'high',
          status: 'new',
          confidence: 0.85,
          data_basis: { engagement: totalEngagement, reach: post.engagement_reach },
          related_post: post.id,
        });
      }
    }
  }

  // ============================================
  // Rule 2: Low SEO score posts need attention
  // ============================================
  for (const post of blogs) {
    if (post.seo_score > 0 && post.seo_score < 50) {
      const title = `SEO verbeteren: "${post.title.substring(0, 50)}" (score: ${post.seo_score})`;
      if (!existingTitles.has(title.toLowerCase())) {
        suggestions.push({
          bedrijf: bedrijfId,
          suggestion_type: 'seo_improvement',
          title,
          description: `Deze blog scoort ${post.seo_score}/100 op SEO. Verbeter de focus keyword, meta description of voeg interne links toe.`,
          priority: 'medium',
          status: 'new',
          confidence: 0.9,
          data_basis: { seo_score: post.seo_score, post_id: post.id },
          related_post: post.id,
        });
      }
    }
  }

  // ============================================
  // Rule 3: Pending review backlog alert
  // ============================================
  if (pending.length >= 5) {
    const title = `${pending.length} posts wachten op review`;
    if (!existingTitles.has(title.toLowerCase())) {
      suggestions.push({
        bedrijf: bedrijfId,
        suggestion_type: 'action_needed',
        title,
        description: `Er staan ${pending.length} posts in de wachtrij voor goedkeuring. Review en publiceer ze om consistent te blijven.`,
        priority: 'high',
        status: 'new',
        confidence: 1.0,
        data_basis: { pending_count: pending.length, post_ids: pending.map(p => p.id) },
      });
    }
  }

  // ============================================
  // Rule 4: Content gap — no recent posts
  // ============================================
  const lastPublished = published[0];
  if (lastPublished) {
    const daysSinceLastPost = Math.floor(
      (Date.now() - new Date(lastPublished.published_at!).getTime()) / (1000 * 60 * 60 * 24)
    );
    if (daysSinceLastPost > 7) {
      const title = `${daysSinceLastPost} dagen geen publicatie voor ${bedrijf.title}`;
      if (!existingTitles.has(title.toLowerCase())) {
        suggestions.push({
          bedrijf: bedrijfId,
          suggestion_type: 'content_gap',
          title,
          description: `De laatste publicatie was ${daysSinceLastPost} dagen geleden. Consistentie is key voor bereik en SEO.`,
          priority: daysSinceLastPost > 14 ? 'high' : 'medium',
          status: 'new',
          confidence: 0.95,
          data_basis: { days_since_last: daysSinceLastPost, last_post: lastPublished.title },
        });
      }
    }
  }

  // ============================================
  // Rule 5: Blog views dropping — republish/update
  // ============================================
  const publishedBlogs = blogs.filter(b => b.published_at && b.blog_views > 0);
  for (const blog of publishedBlogs) {
    if (blog.blog_views < 10 && blog.seo_score >= 60) {
      const title = `Blog updaten: "${blog.title.substring(0, 50)}" — goede SEO maar weinig views`;
      if (!existingTitles.has(title.toLowerCase())) {
        suggestions.push({
          bedrijf: bedrijfId,
          suggestion_type: 'content_refresh',
          title,
          description: `Deze blog scoort ${blog.seo_score} op SEO maar heeft pas ${blog.blog_views} views. Deel opnieuw op social media of update de content.`,
          priority: 'low',
          status: 'new',
          confidence: 0.7,
          data_basis: { views: blog.blog_views, seo_score: blog.seo_score },
          related_post: blog.id,
        });
      }
    }
  }

  // ============================================
  // Rule 6: Seasonal suggestions (IJs uit de Polder)
  // ============================================
  const month = new Date().getMonth() + 1; // 1-12
  if (bedrijfId === 7) { // IJs uit de Polder
    if (month >= 3 && month <= 4) {
      const title = 'Seizoensstart campagne — lente/Pasen content';
      if (!existingTitles.has(title.toLowerCase())) {
        suggestions.push({
          bedrijf: bedrijfId,
          suggestion_type: 'seasonal',
          title,
          description: 'Het ijsseizoen begint! Start met content over nieuwe smaken, seizoensopening, en Paas-specials. Boekingen voor bruiloften in mei/juni binnenhalen.',
          priority: 'high',
          status: 'new',
          confidence: 0.95,
          data_basis: { month, season: 'spring_start' },
        });
      }
    }
    if (month >= 5 && month <= 8) {
      const title = 'Piekseizoen — maximale social media output';
      if (!existingTitles.has(title.toLowerCase())) {
        suggestions.push({
          bedrijf: bedrijfId,
          suggestion_type: 'seasonal',
          title,
          description: 'Piekseizoen! Dagelijks posten: evenement recaps, behind-the-scenes, smaak spotlights. Zorg dat alle platforms actief zijn.',
          priority: 'high',
          status: 'new',
          confidence: 0.95,
          data_basis: { month, season: 'peak' },
        });
      }
    }
  }

  // ============================================
  // Save new suggestions
  // ============================================
  let created = 0;
  for (const suggestion of suggestions) {
    try {
      await directus.request(createItem('AI_Suggestions', suggestion as unknown as Record<string, unknown>));
      created++;
    } catch (error) {
      logger.warn(`Failed to create suggestion: ${suggestion.title}`, error);
    }
  }

  // Clean up old dismissed suggestions (older than 30 days)
  try {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const old = await directus.request(
      readItems('AI_Suggestions', {
        filter: {
          status: { _eq: 'dismissed' },
          date_created: { _lt: oldDate } as any,
        },
        fields: ['id'],
        limit: 50,
      })
    ) as Array<{ id: number }>;

    for (const item of old) {
      await directus.request(updateItem('AI_Suggestions', item.id, { status: 'archived' }));
    }
    if (old.length > 0) {
      logger.info(`Archived ${old.length} old dismissed suggestions`);
    }
  } catch (error) {
    logger.warn('Failed to clean up old suggestions:', error);
  }

  logger.info(`AI Suggestions for bedrijf ${bedrijfId}: ${created} new suggestions (${suggestions.length} evaluated)`);
  return { created };
}

// ============================================
// Get suggestions summary for dashboard
// ============================================

export async function getSuggestionsDashboard(bedrijfId: number): Promise<{
  total: number;
  new: number;
  byType: Record<string, number>;
  suggestions: Array<{
    id: number;
    title: string;
    type: string;
    priority: string;
    status: string;
    confidence: number;
    date: string;
  }>;
}> {
  const items = await directus.request(
    readItems('AI_Suggestions', {
      filter: {
        bedrijf: { _eq: bedrijfId },
        status: { _in: ['new', 'viewed', 'accepted'] },
      },
      sort: ['-date_created'],
      limit: 50,
    })
  ) as Array<{
    id: number; title: string; suggestion_type: string;
    priority: string; status: string; confidence: number; date_created: string;
  }>;

  const byType: Record<string, number> = {};
  for (const item of items) {
    byType[item.suggestion_type] = (byType[item.suggestion_type] || 0) + 1;
  }

  return {
    total: items.length,
    new: items.filter(i => i.status === 'new').length,
    byType,
    suggestions: items.map(i => ({
      id: i.id,
      title: i.title,
      type: i.suggestion_type,
      priority: i.priority,
      status: i.status,
      confidence: i.confidence,
      date: i.date_created,
    })),
  };
}

logger.info('✅ AI Suggestion Engine initialized');
