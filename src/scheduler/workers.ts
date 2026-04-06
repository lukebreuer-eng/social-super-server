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

    // Find active social accounts for this platform
    const accounts = await db.getActiveAccounts(bedrijfId);
    const platformAccounts = accounts.filter(a => a.platform === platform);
    const accountIds = platformAccounts.map(a => a.id);

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
      social_accounts: accountIds,
    });

    logger.info(`Created post ${post.id} for bedrijf ${bedrijfId} - awaiting review`);

    await db.logAction(post.id, 'content_generated', `AI generated ${postType} for ${platform}`, true);

    // Send review notification email
    try {
      const { sendPostReadyForReview } = await import('../email/notifications');
      await sendPostReadyForReview(post, bedrijf);
    } catch (error) {
      logger.warn('Failed to send review notification email:', error);
    }

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

    // Send lead notification email
    try {
      const { sendNewLeadNotification } = await import('../email/notifications');
      const { directus } = await import('../config/directus');
      const { readItems } = await import('@directus/sdk');

      const leads = await directus.request(
        readItems('Leads', { filter: { id: { _eq: leadId } }, limit: 1 })
      ) as import('../config/directus').Lead[];

      if (leads.length > 0) {
        const lead = leads[0];
        const bedrijf = await db.getBedrijf(lead.bedrijf);
        await sendNewLeadNotification(lead, bedrijf);
      }
    } catch (error) {
      logger.warn('Failed to send lead notification email:', error);
    }

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

    // Send weekly digest email
    if (reportType === 'weekly') {
      try {
        const { sendWeeklyDigest } = await import('../email/notifications');
        const bedrijf = await db.getBedrijf(bedrijfId);
        await sendWeeklyDigest(bedrijf.title, {
          posts: result.summary.publishedPosts,
          leads: result.summary.newLeads,
          engagement: result.summary.totalEngagement,
          topPost: result.summary.topPost?.title || '',
        });
      } catch (error) {
        logger.warn('Failed to send weekly digest email:', error);
      }
    }

    return result;
  },
  {
    ...connection,
    concurrency: 1,
  }
);

// ============================================
// Worker: Blog Generation
// ============================================
export const blogGenerationWorker = new Worker(
  'blog-generation',
  async (job: Job) => {
    const { bedrijfId, keyword, topic, targetWordCount } = job.data;
    logger.info(`Generating blog for bedrijf ${bedrijfId}: keyword="${keyword}"`);

    const { generateBlog } = await import('../blog/blog-generator');

    const bedrijf = await db.getBedrijf(bedrijfId);
    const templates = await db.getTemplates(bedrijfId, 'blog');

    const result = await generateBlog({
      bedrijf,
      keyword,
      topic,
      targetWordCount,
      templates,
    });

    // Step 1: Search WordPress media library for a matching image
    const { searchWordPressMedia } = await import('../publishers/wordpress-publisher');
    const { directus } = await import('../config/directus');
    const { readItems } = await import('@directus/sdk');

    let mediaUrl: string | null = null;

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
    ) as Array<{ url: string; access_token: string; platform_user_id: string }>;

    if (wpSites.length > 0) {
      try {
        // Extract search terms from blog title
        const searchTerms = result.title.split(/[\s:—\-,]+/).filter((w: string) => w.length > 3).slice(0, 3);
        searchTerms.push(keyword); // Also search on the keyword

        const wpMedia = await searchWordPressMedia(
          { url: wpSites[0].url, username: wpSites[0].platform_user_id, appPassword: wpSites[0].access_token },
          searchTerms
        );

        if (wpMedia) {
          // Download WP image and upload to Directus Files
          const axios = (await import('axios')).default;
          const imageResponse = await axios.get(wpMedia.url, { responseType: 'arraybuffer' });
          const imageBuffer = Buffer.from(imageResponse.data);

          const FormData = (await import('form-data')).default;
          const form = new FormData();
          form.append('file', imageBuffer, { filename: `blog-${bedrijfId}-wp.png`, contentType: 'image/png' });

          const { env } = await import('../config/env');
          const uploadResponse = await axios.post(`${env.DIRECTUS_URL}/files`, form, {
            headers: { ...form.getHeaders(), 'Authorization': `Bearer ${env.DIRECTUS_TOKEN}` },
          });

          mediaUrl = uploadResponse.data.data.id;
          logger.info(`Blog image from WP media library: ${wpMedia.url} → Directus file: ${mediaUrl}`);
        }
      } catch (error) {
        logger.warn('WP media search failed, falling back to generated image:', error);
      }
    }

    // Step 2: If no WP media found, generate a branded image
    if (!mediaUrl) {
      try {
        const { generateImage } = await import('../visual-engine/image-generator');
        const image = await generateImage(
          bedrijf,
          {
            title: result.title,
            subtitle: bedrijf.title,
            template: 'announcement',
          },
          'facebook-post'
        );
        mediaUrl = image.directusFileId || image.url;
        logger.info(`Blog image generated: ${image.key} (directus file: ${image.directusFileId})`);
      } catch (error) {
        logger.warn('Blog image generation failed, creating post without image:', error);
      }
    }

    // Create blog post in Directus with pending_review status
    const post = await db.createPost({
      title: result.title,
      caption: result.content,
      bedrijf: bedrijfId,
      post_type: 'blog',
      ai_generated: true,
      ai_prompt_used: result.promptUsed,
      ai_confidence_score: result.confidenceScore,
      approval_status: 'pending_review',
      cta_link: bedrijf.website || '',
      cta_text: result.metaTitle,
      hashtags: result.tags,
      media: mediaUrl,
    });

    logger.info(`Blog post ${post.id} created for bedrijf ${bedrijfId} - awaiting review`);

    await db.logAction(post.id, 'blog_generated', `AI generated blog: "${result.title}" (${result.wordCount} words)`, true);

    // Send review notification
    try {
      const { sendPostReadyForReview } = await import('../email/notifications');
      await sendPostReadyForReview(post, bedrijf);
    } catch (error) {
      logger.warn('Failed to send blog review notification:', error);
    }

    return { postId: post.id, title: result.title, wordCount: result.wordCount };
  },
  {
    ...connection,
    concurrency: 2,
    limiter: { max: 5, duration: 60000 },
  }
);

// ============================================
// Worker: Blog Publishing
// ============================================
export const blogPublishWorker = new Worker(
  'blog-publish',
  async (job: Job) => {
    const { postId } = job.data;
    logger.info(`Publishing blog post ${postId} to WordPress`);

    const { publishToWordPress } = await import('../publishers/wordpress-publisher');
    const { directus } = await import('../config/directus');
    const { readItems } = await import('@directus/sdk');

    // Get the post (including media field)
    const posts = await directus.request(
      readItems('Posts', { filter: { id: { _eq: postId } }, limit: 1 })
    ) as Array<{
      id: number; title: string; caption: string; bedrijf: number;
      hashtags: string[]; cta_text: string; approval_status: string;
      media: string | null;
    }>;

    if (!posts.length) throw new Error(`Blog post ${postId} not found`);
    const post = posts[0];

    if (post.approval_status !== 'approved' && post.approval_status !== 'publishing') {
      throw new Error(`Blog post ${postId} not approved (status: ${post.approval_status})`);
    }

    // Get WordPress site credentials
    const wpSites = await directus.request(
      readItems('Social_Accounts', {
        filter: {
          bedrijf: { _eq: post.bedrijf },
          platform: { _eq: 'wordpress' },
          is_connected: { _eq: true },
        },
        limit: 1,
      })
    ) as Array<{ url: string; access_token: string; platform_user_id: string }>;

    if (!wpSites.length) {
      throw new Error(`No WordPress site configured for bedrijf ${post.bedrijf}`);
    }

    const wpSite = {
      url: wpSites[0].url,
      username: wpSites[0].platform_user_id,
      appPassword: wpSites[0].access_token,
    };

    // Upload featured image to WordPress if we have one in Directus
    let featuredImageId: number | undefined;
    if (post.media) {
      try {
        const { env } = await import('../config/env');
        const axios = (await import('axios')).default;

        // Download image from Directus
        const imageResponse = await axios.get(
          `${env.DIRECTUS_URL}/assets/${post.media}`,
          { responseType: 'arraybuffer', headers: { 'Authorization': `Bearer ${env.DIRECTUS_TOKEN}` } }
        );

        // Upload to WordPress
        const wpApiUrl = `${wpSite.url.replace(/\/$/, '')}/wp-json/wp/v2`;
        const wpAuth = Buffer.from(`${wpSite.username}:${wpSite.appPassword}`).toString('base64');

        const FormData = (await import('form-data')).default;
        const form = new FormData();
        form.append('file', Buffer.from(imageResponse.data), {
          filename: `blog-${postId}.png`,
          contentType: 'image/png',
        });

        const uploadResponse = await axios.post(`${wpApiUrl}/media`, form, {
          headers: { ...form.getHeaders(), 'Authorization': `Basic ${wpAuth}` },
        });

        featuredImageId = uploadResponse.data.id;
        logger.info(`Featured image uploaded to WordPress: ${featuredImageId}`);
      } catch (error) {
        logger.warn('Failed to upload featured image to WordPress:', error);
      }
    }

    // Add wp-block-heading classes to headings for proper Flatsome/Gutenberg styling
    const styledContent = post.caption
      .replace(/<h2>/g, '<h2 class="wp-block-heading">')
      .replace(/<h3>/g, '<h3 class="wp-block-heading">');

    const result = await publishToWordPress({
      site: wpSite,
      title: post.title,
      slug: post.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      content: styledContent,
      excerpt: (post.cta_text || '').substring(0, 160),
      status: 'publish',
      tags: post.hashtags || [],
      featuredImageId,
      metaTitle: post.cta_text || post.title,
      focusKeyword: (post.hashtags || [])[0] || '',
    });

    await db.updatePost(postId, {
      published_at: new Date().toISOString(),
      platform_post_id: String(result.postId),
      platform_post_url: result.postUrl,
      approval_status: 'published',
    });

    await db.logAction(postId, 'blog_published', `Published to WordPress: ${result.postUrl}`, true);

    logger.info(`Blog ${postId} published: ${result.postUrl}`);
    return result;
  },
  {
    ...connection,
    concurrency: 1,
    limiter: { max: 3, duration: 60000 },
  }
);

// ============================================
// Worker: Blog Analytics
// ============================================
export const blogAnalyticsWorker = new Worker(
  'blog-analytics',
  async (job: Job) => {
    const { bedrijfId } = job.data;
    logger.info(`Syncing blog analytics for bedrijf ${bedrijfId}`);

    const { syncBlogAnalytics } = await import('../blog/blog-analytics');
    const result = await syncBlogAnalytics(bedrijfId);

    logger.info(`Blog analytics synced: ${result.postsUpdated} posts, ${result.totalViews} views`);
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
    blogGenerationWorker.close(),
    blogPublishWorker.close(),
    blogAnalyticsWorker.close(),
    analyticsWorker.close(),
  ]);
  logger.info('All workers shut down');
}

logger.info('✅ BullMQ workers initialized');
