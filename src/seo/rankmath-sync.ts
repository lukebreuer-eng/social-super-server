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
// Fetch Rank Math SEO data via links/posts API
// ============================================

interface RankMathLinksPost {
  post_id: string;
  post_title: string;
  post_type: string;
  seo_score: number;
  internal_link_count: number;
  external_link_count: number;
  incoming_link_count: number;
  is_orphan: boolean;
  post_url: string;
}

/**
 * Fetch all Rank Math post data for a WordPress site.
 * Uses /rankmath/v1/links/posts which returns SEO scores, link counts etc.
 */
async function fetchRankMathPostsMap(
  site: WordPressSite
): Promise<Map<number, RankMathLinksPost>> {
  const baseUrl = site.url.replace(/\/$/, '');
  const auth = Buffer.from(`${site.username}:${site.appPassword}`).toString('base64');
  const headers = { 'Authorization': `Basic ${auth}` };

  const map = new Map<number, RankMathLinksPost>();

  try {
    // Fetch posts only (not pages) — paginate to get all
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await axios.get(`${baseUrl}/wp-json/rankmath/v1/links/posts`, {
        headers,
        params: { per_page: 100, page, post_type: ['post'] },
      });

      const posts: RankMathLinksPost[] = response.data.posts || [];
      for (const p of posts) {
        map.set(parseInt(p.post_id, 10), p);
      }

      const totalPages = response.data.pages || 1;
      hasMore = page < totalPages;
      page++;
    }

    logger.info(`Fetched Rank Math data for ${map.size} posts from ${baseUrl}`);
  } catch (error) {
    logger.warn(`Failed to fetch Rank Math links/posts from ${site.url}:`, error);
  }

  return map;
}

/**
 * Fetch Rank Math meta + content for a single post and calculate SEO score.
 * Rank Math only calculates scores in the browser editor, so for REST API
 * published posts we calculate our own score based on SEO best practices.
 */
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
      params: { _fields: 'meta,title,content,excerpt' },
    });

    const meta = response.data.meta || {};
    const title = response.data.title?.rendered || '';
    const content = response.data.content?.rendered || '';
    const excerpt = response.data.excerpt?.rendered || '';
    const focusKeyword = meta.rank_math_focus_keyword || '';
    const seoTitle = meta.rank_math_title || '';
    const seoDescription = meta.rank_math_description || '';

    // Calculate SEO score based on key factors
    const score = calculateSeoScore({
      title, content, excerpt, focusKeyword, seoTitle, seoDescription,
    });

    return {
      seoScore: score,
      focusKeyword,
      seoTitle,
      seoDescription,
      robots: '',
      internalLinksCount: 0,
      externalLinksCount: 0,
    };
  } catch (error) {
    logger.warn(`Failed to fetch Rank Math meta for post ${wpPostId}:`, error);
    return null;
  }
}

/**
 * Calculate an SEO score (0-100) based on content analysis.
 * Mirrors key checks that Rank Math performs in the browser.
 */
function calculateSeoScore(data: {
  title: string;
  content: string;
  excerpt: string;
  focusKeyword: string;
  seoTitle: string;
  seoDescription: string;
}): number {
  const { title, content, excerpt, focusKeyword, seoTitle, seoDescription } = data;
  const contentText = content.replace(/<[^>]+>/g, '').toLowerCase();
  const keyword = focusKeyword.toLowerCase().trim();
  let score = 0;

  // Focus keyword set (10 pts)
  if (keyword) score += 10;

  // Focus keyword in title (10 pts)
  if (keyword && title.toLowerCase().includes(keyword)) score += 10;

  // Focus keyword in SEO title (5 pts)
  if (keyword && seoTitle.toLowerCase().includes(keyword)) score += 5;

  // Focus keyword in content (10 pts)
  if (keyword && contentText.includes(keyword)) score += 10;

  // Focus keyword in first 10% of content (5 pts)
  const firstChunk = contentText.substring(0, Math.ceil(contentText.length * 0.1));
  if (keyword && firstChunk.includes(keyword)) score += 5;

  // Keyword density 0.5-2.5% (10 pts)
  if (keyword && contentText.length > 0) {
    const wordCount = contentText.split(/\s+/).length;
    const kwCount = contentText.split(keyword).length - 1;
    const density = (kwCount / wordCount) * 100;
    if (density >= 0.5 && density <= 2.5) score += 10;
    else if (density > 0 && density < 0.5) score += 5;
  }

  // SEO title set and good length 50-60 chars (5 pts)
  if (seoTitle) {
    score += seoTitle.length >= 30 && seoTitle.length <= 65 ? 5 : 2;
  }

  // SEO description set and good length 120-160 chars (5 pts)
  if (seoDescription) {
    score += seoDescription.length >= 100 && seoDescription.length <= 165 ? 5 : 2;
  }

  // Content length > 600 words (10 pts), > 300 (5 pts)
  const wordCount = contentText.split(/\s+/).length;
  if (wordCount >= 600) score += 10;
  else if (wordCount >= 300) score += 5;

  // Has headings h2/h3 (5 pts)
  if (/<h[23][\s>]/i.test(content)) score += 5;

  // Has images (5 pts)
  if (/<img\s/i.test(content)) score += 5;

  // Has internal/external links (5 pts)
  if (/<a\s[^>]*href/i.test(content)) score += 5;

  // Excerpt/meta description contains keyword (5 pts)
  if (keyword && (excerpt.toLowerCase().includes(keyword) || seoDescription.toLowerCase().includes(keyword))) {
    score += 5;
  }

  return Math.min(score, 100);
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

  // Fetch all Rank Math data in one batch (scores + link counts)
  const rankMathMap = await fetchRankMathPostsMap(wpSite);

  let postsUpdated = 0;
  let totalScore = 0;

  for (const post of posts) {
    try {
      // Get SEO score from Rank Math links/posts API (if available)
      const rmData = rankMathMap.get(post.wp_post_id);
      const rmScore = rmData?.seo_score || 0;

      // Get meta fields + calculated score from WP REST API
      const metaData = await fetchRankMathData(wpSite, post.wp_post_id);

      // Use Rank Math's score if it calculated one, otherwise use our own
      const seoScore = rmScore > 0 ? rmScore : (metaData?.seoScore || 0);

      await directus.request(
        updateItem('Posts', post.id, {
          seo_score: seoScore,
          seo_focus_keyword: metaData?.focusKeyword || '',
          seo_title: metaData?.seoTitle || '',
          seo_description: metaData?.seoDescription || '',
        } as Record<string, unknown>)
      );

      totalScore += seoScore;
      postsUpdated++;

      logger.debug(`SEO synced for "${post.title}": score=${seoScore}${rmScore > 0 ? ' (Rank Math)' : ' (calculated)'}, keyword="${metaData?.focusKeyword}"`);
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
