import { directus, db } from '../config/directus';
import { readItems, createItem } from '@directus/sdk';
import { logger } from '../utils/logger';

// ============================================
// Report Generator
// ============================================

interface ReportResult {
  bedrijfId: number;
  reportType: string;
  reportUrl: string;
  summary: ReportSummary;
}

interface ReportSummary {
  period: string;
  totalPosts: number;
  publishedPosts: number;
  totalEngagement: number;
  avgEngagementScore: number;
  topPost: { id: number; title: string; score: number } | null;
  newLeads: number;
  hotLeads: number;
  platformBreakdown: Record<string, { posts: number; engagement: number }>;
}

export async function generateReport(
  bedrijfId: number,
  reportType: string
): Promise<ReportResult> {
  const bedrijf = await db.getBedrijf(bedrijfId);

  // Determine date range
  const now = new Date();
  const startDate = new Date();

  if (reportType === 'weekly') {
    startDate.setDate(now.getDate() - 7);
  } else if (reportType === 'monthly') {
    startDate.setMonth(now.getMonth() - 1);
  }

  // Fetch published posts in period
  const posts = await directus.request(
    readItems('Posts', {
      filter: {
        bedrijf: { _eq: bedrijfId },
        published_at: {
          _between: [startDate.toISOString(), now.toISOString()],
        } as any,
      },
      sort: ['-engagement_score'],
    })
  ) as Array<{
    id: number;
    title: string;
    post_type: string;
    engagement_likes: number;
    engagement_comments: number;
    engagement_shares: number;
    engagement_saves: number;
    engagement_clicks: number;
    engagement_score: number;
    social_accounts: number[];
  }>;

  // Fetch new leads in period
  const leads = await directus.request(
    readItems('Leads', {
      filter: {
        bedrijf: { _eq: bedrijfId },
        date_created: {
          _between: [startDate.toISOString(), now.toISOString()],
        },
      },
    })
  ) as Array<{ lead_temperature: string }>;

  // Calculate metrics
  const totalEngagement = posts.reduce((sum, p) =>
    sum + (p.engagement_likes || 0) + (p.engagement_comments || 0) +
    (p.engagement_shares || 0) + (p.engagement_saves || 0) + (p.engagement_clicks || 0),
    0
  );

  const avgScore = posts.length > 0
    ? posts.reduce((sum, p) => sum + (p.engagement_score || 0), 0) / posts.length
    : 0;

  const topPost = posts.length > 0
    ? { id: posts[0].id, title: posts[0].title, score: posts[0].engagement_score || 0 }
    : null;

  const hotLeads = leads.filter(l => l.lead_temperature === 'hot').length;

  // Platform breakdown - resolve social accounts to get platform info
  const platformBreakdown: Record<string, { posts: number; engagement: number }> = {};

  // Collect all unique social account IDs from posts
  const allAccountIds = [...new Set(posts.flatMap(p => p.social_accounts || []))];

  if (allAccountIds.length > 0) {
    const accounts = await directus.request(
      readItems('Social_Accounts', {
        filter: { id: { _in: allAccountIds } },
      })
    ) as Array<{ id: number; platform: string }>;

    const accountPlatformMap = new Map(accounts.map(a => [a.id, a.platform]));

    for (const post of posts) {
      const postEngagement =
        (post.engagement_likes || 0) + (post.engagement_comments || 0) +
        (post.engagement_shares || 0) + (post.engagement_saves || 0) + (post.engagement_clicks || 0);

      const platforms = (post.social_accounts || [])
        .map(id => accountPlatformMap.get(id))
        .filter((p): p is string => !!p);

      // Deduplicate platforms per post
      const uniquePlatforms = [...new Set(platforms)];

      for (const platform of uniquePlatforms) {
        if (!platformBreakdown[platform]) {
          platformBreakdown[platform] = { posts: 0, engagement: 0 };
        }
        platformBreakdown[platform].posts++;
        platformBreakdown[platform].engagement += postEngagement;
      }
    }
  }

  const summary: ReportSummary = {
    period: `${startDate.toISOString().split('T')[0]} - ${now.toISOString().split('T')[0]}`,
    totalPosts: posts.length,
    publishedPosts: posts.length,
    totalEngagement,
    avgEngagementScore: Math.round(avgScore * 10) / 10,
    topPost,
    newLeads: leads.length,
    hotLeads,
    platformBreakdown,
  };

  // Save report to Insights collection
  await directus.request(
    createItem('Insights', {
      bedrijf: bedrijfId,
      type: reportType,
      period_start: startDate.toISOString(),
      period_end: now.toISOString(),
      data: summary,
      date_created: now.toISOString(),
    })
  );

  logger.info(`${reportType} report generated for ${bedrijf.title}: ${posts.length} posts, ${leads.length} leads`);

  return {
    bedrijfId,
    reportType,
    reportUrl: `${process.env.DIRECTUS_URL}/admin/content/Insights`,
    summary,
  };
}

logger.info('â Report Generator initialized');
