import { directus } from '../config/directus';
import { readItems, updateItem } from '@directus/sdk';
import { fetchWordPressPostStats, WordPressSite } from '../publishers/wordpress-publisher';
import { logger } from '../utils/logger';

// ============================================
// Types
// ============================================

interface BlogPost {
  id: number;
  bedrijf: number;
  wp_post_id: number;
  wp_site_url: string;
  wp_post_url: string;
  blog_views: number;
  blog_comments: number;
  published_at: string;
}

interface BlogAnalyticsResult {
  postsUpdated: number;
  totalViews: number;
}

// ============================================
// Sync blog analytics from WordPress
// ============================================

export async function syncBlogAnalytics(bedrijfId: number): Promise<BlogAnalyticsResult> {
  // Get all published blog posts for this bedrijf
  const posts = await directus.request(
    readItems('Posts', {
      filter: {
        bedrijf: { _eq: bedrijfId },
        post_type: { _eq: 'blog' },
        published_at: { _nnull: true },
        wp_post_id: { _nnull: true },
      },
      sort: ['-published_at'],
      limit: 50,
    })
  ) as BlogPost[];

  if (!posts.length) {
    return { postsUpdated: 0, totalViews: 0 };
  }

  // Get WordPress credentials for this bedrijf
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
    access_token: string; // WP app password
    platform_user_id: string; // WP username
  }>;

  if (!wpSites.length) {
    logger.warn(`No WordPress site configured for bedrijf ${bedrijfId}`);
    return { postsUpdated: 0, totalViews: 0 };
  }

  const wpSite: WordPressSite = {
    url: wpSites[0].url,
    username: wpSites[0].platform_user_id,
    appPassword: wpSites[0].access_token,
  };

  let postsUpdated = 0;
  let totalViews = 0;

  for (const post of posts) {
    try {
      const stats = await fetchWordPressPostStats(wpSite, post.wp_post_id);

      await directus.request(
        updateItem('Posts', post.id, {
          blog_views: stats.views,
          blog_comments: stats.comments,
        })
      );

      totalViews += stats.views;
      postsUpdated++;
    } catch (error) {
      logger.warn(`Failed to sync analytics for blog post ${post.id}:`, error);
    }
  }

  logger.info(`Blog analytics synced for bedrijf ${bedrijfId}: ${postsUpdated} posts, ${totalViews} total views`);

  return { postsUpdated, totalViews };
}

// ============================================
// Blog performance summary for dashboard
// ============================================

export async function getBlogDashboard(bedrijfId: number): Promise<{
  totalBlogs: number;
  publishedBlogs: number;
  pendingReview: number;
  totalViews: number;
  totalComments: number;
  avgViewsPerPost: number;
  topBlogs: Array<{ id: number; title: string; views: number; url: string }>;
  recentBlogs: Array<{ id: number; title: string; status: string; date: string }>;
}> {
  // All blog posts
  const allBlogs = await directus.request(
    readItems('Posts', {
      filter: {
        bedrijf: { _eq: bedrijfId },
        post_type: { _eq: 'blog' },
      },
      sort: ['-date_created'],
    })
  ) as Array<{
    id: number;
    title: string;
    approval_status: string;
    published_at: string | null;
    date_created: string;
    blog_views: number;
    blog_comments: number;
    wp_post_url: string;
  }>;

  const published = allBlogs.filter(b => b.published_at);
  const pending = allBlogs.filter(b => b.approval_status === 'pending_review');

  const totalViews = published.reduce((sum, b) => sum + (b.blog_views || 0), 0);
  const totalComments = published.reduce((sum, b) => sum + (b.blog_comments || 0), 0);
  const avgViews = published.length > 0 ? Math.round(totalViews / published.length) : 0;

  // Top 5 blogs by views
  const topBlogs = [...published]
    .sort((a, b) => (b.blog_views || 0) - (a.blog_views || 0))
    .slice(0, 5)
    .map(b => ({
      id: b.id,
      title: b.title,
      views: b.blog_views || 0,
      url: b.wp_post_url || '',
    }));

  // Recent 10 blogs (all statuses)
  const recentBlogs = allBlogs.slice(0, 10).map(b => ({
    id: b.id,
    title: b.title,
    status: b.approval_status,
    date: b.published_at || b.date_created,
  }));

  return {
    totalBlogs: allBlogs.length,
    publishedBlogs: published.length,
    pendingReview: pending.length,
    totalViews,
    totalComments,
    avgViewsPerPost: avgViews,
    topBlogs,
    recentBlogs,
  };
}

logger.info('✅ Blog Analytics initialized');
