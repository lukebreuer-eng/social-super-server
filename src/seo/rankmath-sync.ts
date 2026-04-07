import axios from 'axios';
import { directus } from '../config/directus';
import { readItems, updateItem } from '@directus/sdk';
import { WordPressSite } from '../publishers/wordpress-publisher';
import { logger } from '../utils/logger';

// ============================================
// Types
// ============================================

export interface RankMathPostData {
  seoScore: number;
  focusKeyword: string;
  seoTitle: string;
  seoDescription: string;
  robots: string;
  internalLinksCount: number;
  externalLinksCount: number;
}

export interface SEODashboardData {
  bedrijfId: number;
  totalPosts: number;
  avgSeoScore: number;
  postsWithScore: number;
  scoreDistribution: {
    good: number;    // 80-100
    ok: number;      // 50-79
    poor: number;    // 0-49
  };
  topKeywords: Array<{ keyword: string; count: number }>;
  worstPosts: Array<{ id: number; title: string; seoScore: number; wpUrl: string }>;
  bestPosts: Array<{ id: number; title: string; seoScore: number; wpUrl: string }>;
  recentScores: Array<{ id: number; title: string; seoScore: number; date: string }>;
}

// ============================================
// Fetch Rank Math SEO data for a single post
// ============================================

export async function fetchRankMathData(
  site: WordPressSite,
  wpPostId: number
): Promise<RankMathPostData | null> {
  const apiUrl = `${site.url.replace(/\/$/, '')}/wp-json/wp/v2`;
  const auth = Buffer.from(`${site.username}:${site.appPassword}`).toString('base64');
  const headers = { 'Authorization': `Basic ${auth}` };

  try {
    const response = await axios.get(`${apiUrl}/posts/${wpPostId}`, {
      headers,
      params: {
        _fields: 'meta',
      },
    });

    const meta = response.data.meta || {};

    return {
      seoScore: parseInt(meta.rank_math_seo_score || '0', 10),
      focusKeyword: meta.rank_math_focus_keyword || '',
      seoTitle: meta.rank_math_title || '',
      seoDescription: meta.rank_math_description || '',
      robots: Array.isArray(meta.rank_math_robots) ? meta.rank_math_robots.join(', ') : (meta.rank_math_robots || ''),
      internalLinksCount: parseInt(meta.rank_math_internal_links_count || '0', 10),
      externalLinksCount: parseInt(meta.rank_math_external_links_count || '0', 10),
    };
  } catch (error) {
    logger.warn(`Failed to fetch Rank Math data for post ${wpPostId} on ${site.url}:`, error);
    return null;
  }
}

// ============================================
// Sync SEO data for all blog posts of a bedrijf
// ============================================

export async function syncSeoData(bedrijfId: number): Promise<{ postsUpdated: number; avgScore: number }> {
  // Get all published blog posts with a wp_post_id
  const posts = await directus.request(
    readItems('Posts', {
      filter: {
        bedrijf: { _eq: bedrijfId },
        post_type: { _eq: 'blog' },
        wp_post_id: { _nnull: true },
        published_at: { _nnull: true },
      },
      sort: ['-published_at'],
      limit: 100,
    })
  ) as Array<{
    id: number;
    wp_post_id: number;
    wp_site_url: string;
    title: string;
  }>;

  if (!posts.length) {
    return { postsUpdated: 0, avgScore: 0 };
  }

  // Get WordPress credentials
  const wpSites = await directus.request(
    readItems('Social_Accounts', {
      filter: {
        bedrijf: { _eq: bedrijfId },
        platform: { _eq: 'wordpress' },
        is_connected: { _eq: true },
      },
      limit: 1,
    })
  ) as Array<{
    url: string;
    access_token: string;
    platform_user_id: string;
  }>;

  if (!wpSites.length) {
    logger.warn(`No WordPress site configured for bedrijf ${bedrijfId}`);
    return { postsUpdated: 0, avgScore: 0 };
  }

  const wpSite: WordPressSite = {
    url: wpSites[0].url,
    username: wpSites[0].platform_user_id,
    appPassword: wpSites[0].access_token,
  };

  let postsUpdated = 0;
  let totalScore = 0;

  for (const post of posts) {
    try {
      const seoData = await fetchRankMathData(wpSite, post.wp_post_id);
      if (!seoData) continue;

      await directus.request(
        updateItem('Posts', post.id, {
          seo_score: seoData.seoScore,
          seo_focus_keyword: seoData.focusKeyword,
          seo_title: seoData.seoTitle,
          seo_description: seoData.seoDescription,
        } as Record<string, unknown>)
      );

      totalScore += seoData.seoScore;
      postsUpdated++;

      logger.debug(`SEO synced for "${post.title}": score=${seoData.seoScore}, keyword="${seoData.focusKeyword}"`);
    } catch (error) {
      logger.warn(`Failed to sync SEO for post ${post.id}:`, error);
    }
  }

  const avgScore = postsUpdated > 0 ? Math.round(totalScore / postsUpdated) : 0;
  logger.info(`SEO sync for bedrijf ${bedrijfId}: ${postsUpdated} posts, avg score: ${avgScore}`);

  return { postsUpdated, avgScore };
}

// ============================================
// SEO Dashboard data
// ============================================

export async function getSEODashboard(bedrijfId: number): Promise<SEODashboardData> {
  const posts = await directus.request(
    readItems('Posts', {
      filter: {
        bedrijf: { _eq: bedrijfId },
        post_type: { _eq: 'blog' },
        wp_post_id: { _nnull: true },
        published_at: { _nnull: true },
      },
      sort: ['-published_at'],
    })
  ) as Array<{
    id: number;
    title: string;
    published_at: string;
    wp_post_url: string;
    seo_score: number;
    seo_focus_keyword: string;
  }>;

  const withScore = posts.filter(p => p.seo_score > 0);

  // Score distribution
  const good = withScore.filter(p => p.seo_score >= 80).length;
  const ok = withScore.filter(p => p.seo_score >= 50 && p.seo_score < 80).length;
  const poor = withScore.filter(p => p.seo_score < 50).length;

  const avgScore = withScore.length > 0
    ? Math.round(withScore.reduce((sum, p) => sum + p.seo_score, 0) / withScore.length)
    : 0;

  // Top focus keywords
  const keywordCounts: Record<string, number> = {};
  for (const post of withScore) {
    const kw = post.seo_focus_keyword?.trim();
    if (kw) {
      keywordCounts[kw] = (keywordCounts[kw] || 0) + 1;
    }
  }
  const topKeywords = Object.entries(keywordCounts)
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Best & worst posts by SEO score
  const sorted = [...withScore].sort((a, b) => a.seo_score - b.seo_score);
  const worstPosts = sorted.slice(0, 5).map(p => ({
    id: p.id, title: p.title, seoScore: p.seo_score, wpUrl: p.wp_post_url || '',
  }));
  const bestPosts = sorted.reverse().slice(0, 5).map(p => ({
    id: p.id, title: p.title, seoScore: p.seo_score, wpUrl: p.wp_post_url || '',
  }));

  // Recent scores
  const recentScores = posts.slice(0, 10).map(p => ({
    id: p.id,
    title: p.title,
    seoScore: p.seo_score || 0,
    date: p.published_at,
  }));

  return {
    bedrijfId,
    totalPosts: posts.length,
    avgSeoScore: avgScore,
    postsWithScore: withScore.length,
    scoreDistribution: { good, ok, poor },
    topKeywords,
    worstPosts,
    bestPosts,
    recentScores,
  };
}

logger.info('✅ Rank Math SEO sync initialized');
