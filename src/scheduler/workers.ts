import { Worker, Job } from 'bullmq';
import { redis } from '../config/redis';
import { db } from '../config/directus';
import { logger } from '../utils/logger';

const connection = { connection: redis };

// ============================================
// Worker: Content Generation
// ============================================
export const contentGenerationWorker = new Worker(
  'content-generation',
  async (job: Job) => {
    const { bedrijfId, platform, postType } = job.data;
    logger.info(`Generating ${postType} content for bedrijf ${bedrijfId} on ${platform}`);

    // Dynamic imports to avoid circular deps
    const { generateContent } = await import('../ai-engine/content-generator');
    const { generateImage } = await import('../visual-engine/image-generator');

    const bedrijf = await db.getBedrijf(bedrijfId);
    const templates = await db.getTemplates(bedrijfId, platform);

    const result = await generateContent({
      bedrijf,
      platform,
      postType,
      templates,
    });

    // Generate branded image for the post
    const templateMap: Record<string, 'quote' | 'announcement' | 'tip' | 'promo' | 'stats'> = {
      educational: 'tip',
      promotional: 'promo',
      engagement: 'quote',
      behind_the_scenes: 'announcement',
      testimonial: 'quote',
      regular: 'announcement',
    };

    const platformFormatMap: Record<string, string> = {
      instagram: 'instagram-square',
      facebook: 'facebook-post',
      linkedin: 'linkedin-post',
      tiktok: 'tiktok-video',
    };

    let mediaUrl: string | null = null;
    try {
      const image = await generateImage(
        bedrijf,
        {
          title: result.title,
          subtitle: result.ctaText || bedrijf.title,
          template: templateMap[postType] || 'announcement',
        },
        platformFormatMap[platform] || 'instagram-square'
      );
      mediaUrl = image.url;
      logger.info(`Image generated for post: ${image.key}`);
    } catch (error) {
      logger.warn('Image generation failed, creating post without image:', error);
    }

    // Create post in Directus with pending_review status
    const post = await db.createPost({
      title: result.title,
      caption: result.caption,
      hashtags: result.hashtags,
      bedrijf: bedrijfId,
      post_type: postType,
      ai_generated: true,
      ai_prompt_used: result.promptUsed,
      ai_confidence_score: result.confidenceScore,
      approval_status: 'pending_review',
      cta_link: result.ctaLink || '',
      cta_text: result.ctaText || '',
      media: mediaUrl,
    });

    logger.info(`Created post ${post.id} for bedrijf ${bedrijfId} - awaiting review`);

    await db.logAction(post.id, 'content_generated', `AI generated ${postType} for ${platform}`, true);

    return { postId: post.id, platform };
  },
  {
    ...connection,
    concurrency: 3,
    limiter: { max: 10, duration: 60000 }, // Max 10 per minute
  }
);

// ============================================
// Worker: Post Publishing
// ============================================
export const postPublishWorker = new Worker(
  'post-publish',
  async (job: Job) => {
    const { postId } = job.data;
    logger.info(`Publishing post ${postId}`);

    const { publishPost } = await import('../publishers/publisher');

    try {
      const result = await publishPost(postId);

      await db.updatePost(postId, {
        published_at: new Date().toISOString(),
        platform_post_id: result.platformPostId,
        platform_post_url: result.platformPostUrl,
        approval_status: 'published',
      });

      await db.logAction(postId, 'published', `Published to ${result.platform}`, true);

      logger.info(`Post ${postId} published successfully to ${result.platform}`);
      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);

      await db.updatePost(postId, {
        error_message: errMsg,
        retry_count: (job.attemptsMade || 0) + 1,
        last_retry_at: new Date().toISOString(),
      });

      await db.logAction(postId, 'publish_failed', errMsg, false);
      throw error;
    }
  },
  {
    ...connection,
    concurrency: 2,
    limiter: { max: 5, duration: 60000 }, // Max 5 publishes per minute
  }
);

// ============================================
// Worker: Engagement Sync
// ============================================
export const engagementSyncWorker = new Worker(
  'engagement-sync',
  async (job: Job) => {
    const { accountId, platform } = job.data;
    logger.info(`Syncing engagement for account ${accountId} (${platform})`);

    const { syncEngagement } = await import('../analytics/engagement-sync');
    const result = await syncEngagement(accountId, platform);

    logger.info(`Synced ${result.postsUpdated} posts for account ${accountId}`);
    return result;
  },
  {
    ...connection,
    concurrency: 3,
    limiter: { max: 10, duration: 60000 },
  }
);

// ============================================
// Worker: Token Refresh
// ============================================
export const tokenRefreshWorker = new Worker(
  'token-refresh',
  async (job: Job) => {
    const { accountId, platform } = job.data;
    logger.info(`Refreshing token for account ${accountId} (${platform})`);

    const { refreshToken } = await import('../oauth/token-manager');
    await refreshToken(accountId, platform);

    logger.info(`Token refreshed for account ${accountId}`);
  },
  {
    ...connection,
    concurrency: 1,
  }
);

// ============================================
// Worker: Lead Processing
// ============================================
export const leadProcessingWorker = new Worker(
  'lead-processing',
  async (job: Job) => {
    const { leadId } = job.data;
    logger.info(`Processing lead ${leadId}`);

    const { processLead } = await import('../leads/lead-scorer');
    const result = await processLead(leadId);

    logger.info(`Lead ${leadId} scored: ${result.temperature} (${result.score})`);
    return result;
  },
  {
    ...connection,
    concurrency: 5,
  }
);

// ============================================
// Worker: Analytics
// ============================================
export const analyticsWorker = new Worker(
  'analytics',
  async (job: Job) => {
    const { bedrijfId, reportType } = job.data;
    logger.info(`Generating ${reportType} report for bedrijf ${bedrijfId}`);

    const { generateReport } = await import('../analytics/report-generator');
    const result = await generateReport(bedrijfId, reportType);

    logger.info(`Report generated for bedrijf ${bedrijfId}: ${result.reportUrl}`);
    return result;
  },
  {
    ...connection,
    concurrency: 1,
  }
);

// ============================================
// Graceful shutdown
// ============================================
export async function shutdownWorkers(): Promise<void> {
  logger.info('Shutting down workers...');
  await Promise.all([
    contentGenerationWorker.close(),
    postPublishWorker.close(),
    engagementSyncWorker.close(),
    tokenRefreshWorker.close(),
    leadProcessingWorker.close(),
    analyticsWorker.close(),
  ]);
  logger.info('All workers shut down');
}

logger.info('✅ BullMQ workers initialized');
