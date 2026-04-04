import axios from 'axios';
import { directus, SocialAccount } from '../config/directus';
import { readItems, updateItem } from '@directus/sdk';
import { logger } from '../utils/logger';

const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';
const LINKEDIN_API_URL = 'https://api.linkedin.com/v2';
const TIKTOK_API_URL = 'https://open.tiktokapis.com/v2';

// ============================================
// Types
// ============================================

interface SyncResult {
  accountId: number;
  platform: string;
  postsUpdated: number;
}

interface EngagementData {
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  reach: number;
  impressions: number;
}

// ============================================
// Main Sync Function
// ============================================

export async function syncEngagement(accountId: number, platform: string): Promise<SyncResult> {
  // Get account
  const accounts = await directus.request(
    readItems('Social_Accounts', { filter: { id: { _eq: accountId } }, limit: 1 })
  ) as SocialAccount[];

  if (!accounts.length) throw new Error(`Account ${accountId} not found`);
  const account = accounts[0];

  // Get published posts for this account's bedrijf
  const posts = await directus.request(
    readItems('Posts', {
      filter: {
        bedrijf: { _eq: account.bedrijf },
        published_at: { _nnull: true },
        platform_post_id: { _nnull: true },
      },
      sort: ['-published_at'],
      limit: 50,
    })
  ) as Array<{ id: number; platform_post_id: string; published_at: string }>;

  let postsUpdated = 0;

  for (const post of posts) {
    try {
      let engagement: EngagementData | null = null;

      switch (platform) {
        case 'facebook':
        case 'instagram':
          engagement = await fetchMetaEngagement(post.platform_post_id, account, platform);
          break;
        case 'linkedin':
          engagement = await fetchLinkedInEngagement(post.platform_post_id, account);
          break;
        case 'tiktok':
          engagement = await fetchTikTokEngagement(post.platform_post_id, account);
          break;
      }

      if (engagement) {
        const score = calculateEngagementScore(engagement);

        await directus.request(
          updateItem('Posts', post.id, {
            engagement_likes: engagement.likes,
            engagement_comments: engagement.comments,
            engagement_shares: engagement.shares,
            engagement_saves: engagement.saves,
            engagement_clicks: engagement.clicks,
            engagement_reach: engagement.reach,
            engagement_impressions: engagement.impressions,
            engagement_score: score,
          })
        );

        postsUpdated++;
      }
    } catch (error) {
      logger.warn(`Failed to sync engagement for post ${post.id}:`, error);
    }
  }

  // Update account last_synced
  await directus.request(
    updateItem('Social_Accounts', accountId, {
      last_synced: new Date().toISOString(),
    })
  );

  return { accountId, platform, postsUpdated };
}

// ============================================
// Platform-specific fetchers
// ============================================

async function fetchMetaEngagement(
  postId: string,
  account: SocialAccount,
  platform: string
): Promise<EngagementData> {
  const fields = platform === 'instagram'
    ? 'like_count,comments_count,timestamp'
    : 'likes.summary(true),comments.summary(true),shares';

  const response = await axios.get(
    `${META_GRAPH_URL}/${postId}?fields=${fields}&access_token=${account.access_token}`
  );

  const data = response.data;

  if (platform === 'instagram') {
    // Also get insights for reach/impressions
    let reach = 0;
    let impressions = 0;

    try {
      const insightsResponse = await axios.get(
        `${META_GRAPH_URL}/${postId}/insights?metric=reach,impressions&access_token=${account.access_token}`
      );
      const insights = insightsResponse.data.data || [];
      reach = insights.find((i: { name: string }) => i.name === 'reach')?.values?.[0]?.value || 0;
      impressions = insights.find((i: { name: string }) => i.name === 'impressions')?.values?.[0]?.value || 0;
    } catch {
      // Insights might not be available for all post types
    }

    return {
      likes: data.like_count || 0,
      comments: data.comments_count || 0,
      shares: 0,
      saves: 0,
      clicks: 0,
      reach,
      impressions,
    };
  }

  // Facebook
  return {
    likes: data.likes?.summary?.total_count || 0,
    comments: data.comments?.summary?.total_count || 0,
    shares: data.shares?.count || 0,
    saves: 0,
    clicks: 0,
    reach: 0,
    impressions: 0,
  };
}

async function fetchLinkedInEngagement(
  postUrn: string,
  account: SocialAccount
): Promise<EngagementData> {
  // Use summary counts from socialActions endpoint instead of array length
  // which is unreliable due to pagination
  const response = await axios.get(
    `${LINKEDIN_API_URL}/socialActions/${postUrn}`,
    {
      headers: {
        'Authorization': `Bearer ${account.access_token}`,
        'X-Restli-Protocol-Version': '2.0.0',
      },
    }
  );

  const data = response.data;

  return {
    likes: data.likesSummary?.totalLikes || data.likes?.length || 0,
    comments: data.commentsSummary?.totalFirstLevelComments || data.comments?.length || 0,
    shares: data.sharesSummary?.totalShares || 0,
    saves: 0,
    clicks: 0,
    reach: 0,
    impressions: 0,
  };
}

async function fetchTikTokEngagement(
  videoId: string,
  account: SocialAccount
): Promise<EngagementData> {
  const response = await axios.post(
    `${TIKTOK_API_URL}/video/query/`,
    {
      filters: {
        video_ids: [videoId],
      },
      fields: ['like_count', 'comment_count', 'share_count', 'view_count'],
    },
    {
      headers: {
        'Authorization': `Bearer ${account.access_token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const video = response.data.data?.videos?.[0];

  if (!video) {
    return { likes: 0, comments: 0, shares: 0, saves: 0, clicks: 0, reach: 0, impressions: 0 };
  }

  return {
    likes: video.like_count || 0,
    comments: video.comment_count || 0,
    shares: video.share_count || 0,
    saves: 0,
    clicks: 0,
    reach: 0,
    impressions: video.view_count || 0,
  };
}

// ============================================
// Engagement Score Calculator
// ============================================

function calculateEngagementScore(engagement: EngagementData): number {
  // Weighted engagement score (0-100)
  const weights = {
    likes: 1,
    comments: 3,
    shares: 5,
    saves: 4,
    clicks: 2,
  };

  const rawScore =
    engagement.likes * weights.likes +
    engagement.comments * weights.comments +
    engagement.shares * weights.shares +
    engagement.saves * weights.saves +
    engagement.clicks * weights.clicks;

  // Normalize: logarithmic scale with max around 100
  const normalized = Math.min(100, Math.round(Math.log(rawScore + 1) * 15));

  return normalized;
}

logger.info('✅ Engagement Sync initialized');
