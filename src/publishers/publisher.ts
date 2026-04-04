import { db, Post, SocialAccount, directus } from '../config/directus';
import { readItems } from '@directus/sdk';
import { logger } from '../utils/logger';
import { cache } from '../config/redis';
import { publishToMeta } from './meta-publisher';
import { publishToLinkedIn } from './linkedin-publisher';
import { publishToTikTok } from './tiktok-publisher';

// ============================================
// Types
// ============================================

export interface PublishResult {
  platform: string;
  platformPostId: string;
  platformPostUrl: string;
  success: boolean;
}

export interface PlatformPublisher {
  publish(post: Post, account: SocialAccount): Promise<PublishResult>;
}

// ============================================
// Publisher Router
// ============================================

const publishers: Record<string, (post: Post, account: SocialAccount) => Promise<PublishResult>> = {
  instagram: publishToMeta,
  facebook: publishToMeta,
  linkedin: publishToLinkedIn,
  tiktok: publishToTikTok,
};

export async function publishPost(postId: number): Promise<PublishResult> {
  // Fetch the specific post directly instead of scanning lists
  const posts = await directus.request(
    readItems('Posts', { filter: { id: { _eq: postId } }, limit: 1 })
  ) as Post[];

  if (!posts.length) {
    throw new Error(`Post ${postId} not found`);
  }

  const actualPost = posts[0];

  if (actualPost.approval_status !== 'approved') {
    throw new Error(`Post ${postId} is not approved (status: ${actualPost.approval_status})`);
  }

  // Get linked social accounts
  const accounts = await db.getActiveAccounts(actualPost.bedrijf);
  if (accounts.length === 0) {
    throw new Error(`No active social accounts for bedrijf ${actualPost.bedrijf}`);
  }

  // Filter accounts linked to this post
  const linkedAccounts = actualPost.social_accounts && actualPost.social_accounts.length > 0
    ? accounts.filter(a => actualPost.social_accounts.includes(a.id))
    : accounts; // If no specific accounts, publish to all active ones

  const results: PublishResult[] = [];

  for (const account of linkedAccounts) {
    const publishFn = publishers[account.platform];
    if (!publishFn) {
      logger.warn(`No publisher for platform: ${account.platform}`);
      continue;
    }

    // Rate limit check per platform
    const rateLimitKey = `ratelimit:publish:${account.platform}:${account.id}`;
    const allowed = await cache.checkRateLimit(rateLimitKey, 10, 3600); // 10 posts per hour per account
    if (!allowed) {
      logger.warn(`Rate limit exceeded for account ${account.id} (${account.platform})`);
      throw new Error(`Rate limit exceeded for ${account.platform}`);
    }

    try {
      const result = await publishFn(actualPost, account);
      results.push(result);
      logger.info(`Published post ${postId} to ${account.platform} (${account.title})`);
    } catch (error) {
      logger.error(`Failed to publish to ${account.platform}:`, error);
      throw error;
    }
  }

  // Return the first successful result (primary platform)
  return results[0] || { platform: 'unknown', platformPostId: '', platformPostUrl: '', success: false };
}
