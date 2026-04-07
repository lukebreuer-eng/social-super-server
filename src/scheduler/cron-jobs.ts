import * as cron from 'cron';
import { db } from '../config/directus';
import { logger } from '../utils/logger';
import {
  contentGenerationQueue,
  postPublishQueue,
  engagementSyncQueue,
  tokenRefreshQueue,
  analyticsQueue,
  blogPublishQueue,
  blogAnalyticsQueue,
  blogGenerationQueue,
  seoSyncQueue,
} from './queues';

const { CronJob } = cron;

// ============================================
// Cron Job Definitions
// ============================================

// Check for posts ready to publish - every 2 minutes
const publishScheduler = new CronJob('*/2 * * * *', async () => {
  try {
    const posts = await db.getScheduledPosts();
    if (posts.length === 0) return;

    logger.info(`Found ${posts.length} posts ready to publish`);

    for (const post of posts) {
      await postPublishQueue.add(
        `publish-${post.id}`,
        { postId: post.id },
        { priority: post.publish_priority }
      );
    }
  } catch (error) {
    logger.error('Publish scheduler error:', error);
  }
});

// Generate content for all bedrijven - every day at 06:00
const contentScheduler = new CronJob('0 6 * * *', async () => {
  try {
    const bedrijven = await db.getBedrijven();
    logger.info(`Generating content for ${bedrijven.length} bedrijven`);

    for (const bedrijf of bedrijven) {
      const accounts = await db.getActiveAccounts(bedrijf.id);
      const platforms = [...new Set(accounts.map(a => a.platform))];

      for (const platform of platforms) {
        await contentGenerationQueue.add(
          `generate-${bedrijf.id}-${platform}`,
          {
            bedrijfId: bedrijf.id,
            platform,
            postType: 'regular',
          },
          { priority: 5 }
        );
      }
    }
  } catch (error) {
    logger.error('Content scheduler error:', error);
  }
});

// Sync engagement metrics - every 30 minutes
const engagementScheduler = new CronJob('*/30 * * * *', async () => {
  try {
    const accounts = await db.getActiveAccounts();
    logger.info(`Syncing engagement for ${accounts.length} accounts`);

    for (const account of accounts) {
      await engagementSyncQueue.add(
        `sync-${account.id}`,
        { accountId: account.id, platform: account.platform }
      );
    }
  } catch (error) {
    logger.error('Engagement sync scheduler error:', error);
  }
});

// Refresh OAuth tokens - every 6 hours
const tokenScheduler = new CronJob('0 */6 * * *', async () => {
  try {
    const accounts = await db.getActiveAccounts();

    for (const account of accounts) {
      // Check if token expires within 24 hours
      const expiresAt = new Date(account.token_expires);
      const hoursUntilExpiry = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);

      if (hoursUntilExpiry < 24) {
        logger.info(`Token for ${account.title} expires in ${hoursUntilExpiry.toFixed(1)}h, refreshing...`);
        await tokenRefreshQueue.add(
          `refresh-${account.id}`,
          { accountId: account.id, platform: account.platform }
        );
      }
    }
  } catch (error) {
    logger.error('Token refresh scheduler error:', error);
  }
});

// Weekly analytics report - every Monday at 08:00
const weeklyReportScheduler = new CronJob('0 8 * * 1', async () => {
  try {
    const bedrijven = await db.getBedrijven();

    for (const bedrijf of bedrijven) {
      await analyticsQueue.add(
        `weekly-report-${bedrijf.id}`,
        { bedrijfId: bedrijf.id, reportType: 'weekly' }
      );
    }
  } catch (error) {
    logger.error('Weekly report scheduler error:', error);
  }
});

// Auto-generate blogs - every Monday and Thursday at 07:00
const blogAutoGenerator = new CronJob('0 7 * * 1,4', async () => {
  try {
    const { directus } = await import('../config/directus');
    const { readItems } = await import('@directus/sdk');

    const bedrijven = await db.getBedrijven();
    logger.info(`Auto-generating blogs for ${bedrijven.length} bedrijven`);

    // Blog topics per bedrijf, based on cold lead plan and competitor analysis
    const blogTopics: Record<string, Array<{ keyword: string; topic: string }>> = {
      'IP Voice Group': [
        { keyword: 'overstappen cloud telefonie', topic: 'Overstappen naar cloud telefonie: het complete stappenplan voor MKB' },
        { keyword: '3CX vs Microsoft Teams', topic: '3CX vs Microsoft Teams bellen: eerlijke vergelijking' },
        { keyword: 'Mitel CX AI contactcenter', topic: 'Mitel CX met Talkative AI: het contactcenter dat zelf meedenkt' },
        { keyword: 'contact center software zorg', topic: 'Contact center software voor de zorg: waar let je op?' },
        { keyword: 'ISO 27001 telefonie', topic: 'ISO 27001 en je communicatie: wat moet je regelen?' },
        { keyword: 'kosten zakelijke telefonie', topic: 'Wat kost zakelijke telefonie per medewerker per maand?' },
        { keyword: 'hybride werken telefonie', topic: 'Hybride werken: waarom je PBX je tegenhoudt' },
        { keyword: 'Teams bellen kwaliteit', topic: 'Teams bellen: waarom de kwaliteit tegenvalt en hoe je het fixt' },
        { keyword: 'Intermedia Elevate UCaaS', topic: 'Intermedia Elevate: de nieuwe all-in-one voor zakelijke communicatie' },
        { keyword: 'zakelijke telefonie trends 2026', topic: 'Zakelijke telefonie trends: wat verandert er in 2026?' },
      ],
      'IJs uit de Polder': [
        { keyword: 'bedford ijswagen huren', topic: 'De Bedford ijswagen: een iconische beleving op je feest' },
        { keyword: 'gelatobar huren', topic: 'Gelatobar huren: de stijlvolle keuze voor je receptie of bruiloft' },
        { keyword: 'ijswagen huren kosten', topic: 'Wat kost het om een ijswagen te huren? Eerlijk overzicht van alle kosten' },
        { keyword: 'ijsscooter huren', topic: 'IJsscooter huren: de verrassende eyecatcher op je feest' },
        { keyword: 'ijswagen huren kinderfeest', topic: 'IJswagen huren voor een kinderfeest: tips en ideeën' },
        { keyword: 'ijswagen huren Flevoland', topic: 'IJswagen huren in Flevoland: lokaal ambachtelijk ijs op je evenement' },
        { keyword: 'ijswagen huren Veluwe', topic: 'IJswagen huren op de Veluwe: van Harderwijk tot Nijkerk' },
        { keyword: 'duurzaam ijs evenement', topic: 'Duurzaam en natuurlijk ijs op je evenement: waar let je op?' },
      ],
      'IP Voice Shop': [
        { keyword: 'beste headset Teams 2026', topic: 'Beste headset voor Microsoft Teams in 2026: top 5 vergelijking' },
        { keyword: 'Jabra Evolve2 vs Yealink', topic: 'Jabra Evolve2 vs Yealink BH76: welke kies je?' },
        { keyword: 'zakelijke conferentie speaker', topic: 'Beste conferentie speakers voor de vergaderruimte' },
        { keyword: 'VoIP telefoon kantoor', topic: 'De beste VoIP telefoons voor op kantoor in 2026' },
      ],
    };

    for (const bedrijf of bedrijven) {
      const topics = blogTopics[bedrijf.title];
      if (!topics || topics.length === 0) continue;

      // Check how many blogs already exist for this bedrijf
      const existingBlogs = await directus.request(
        readItems('Posts', {
          filter: {
            bedrijf: { _eq: bedrijf.id },
            post_type: { _eq: 'blog' },
          },
          fields: ['title'],
        })
      ) as Array<{ title: string }>;

      const existingTitles = existingBlogs.map(b => b.title.toLowerCase());

      // Find a topic that hasn't been written about yet
      const unusedTopic = topics.find(t =>
        !existingTitles.some(title => title.includes(t.keyword.toLowerCase().split(' ')[0]))
      );

      if (unusedTopic) {
        await blogGenerationQueue.add(
          `auto-blog-${bedrijf.id}-${Date.now()}`,
          {
            bedrijfId: bedrijf.id,
            keyword: unusedTopic.keyword,
            topic: unusedTopic.topic,
            targetWordCount: 1000,
          },
          { priority: 5 }
        );
        logger.info(`Auto-blog queued for ${bedrijf.title}: "${unusedTopic.keyword}"`);
      } else {
        logger.info(`All blog topics used for ${bedrijf.title}, skipping`);
      }
    }
  } catch (error) {
    logger.error('Blog auto-generator error:', error);
  }
});

// Check for approved blogs ready to publish - every 5 minutes
const blogPublishScheduler = new CronJob('*/5 * * * *', async () => {
  try {
    const { directus } = await import('../config/directus');
    const { readItems, updateItem } = await import('@directus/sdk');

    const blogs = await directus.request(
      readItems('Posts', {
        filter: {
          post_type: { _eq: 'blog' },
          approval_status: { _eq: 'approved' },
          published_at: { _null: true },
        },
      })
    ) as Array<{ id: number }>;

    if (blogs.length === 0) return;

    logger.info(`Found ${blogs.length} approved blogs ready to publish`);

    for (const blog of blogs) {
      // Mark as publishing to prevent duplicate queue entries
      await directus.request(
        updateItem('Posts', blog.id, { approval_status: 'publishing' })
      );

      await blogPublishQueue.add(
        `blog-publish-${blog.id}`,
        { postId: blog.id }
      );
    }
  } catch (error) {
    logger.error('Blog publish scheduler error:', error);
  }
});

// Sync Rank Math SEO data - every 12 hours (06:30 and 18:30)
const seoSyncScheduler = new CronJob('30 6,18 * * *', async () => {
  try {
    const bedrijven = await db.getBedrijven();

    for (const bedrijf of bedrijven) {
      await seoSyncQueue.add(
        `seo-sync-${bedrijf.id}`,
        { bedrijfId: bedrijf.id }
      );
    }
  } catch (error) {
    logger.error('SEO sync scheduler error:', error);
  }
});

// Sync blog analytics - every 6 hours
const blogAnalyticsScheduler = new CronJob('0 */6 * * *', async () => {
  try {
    const bedrijven = await db.getBedrijven();

    for (const bedrijf of bedrijven) {
      await blogAnalyticsQueue.add(
        `blog-analytics-${bedrijf.id}`,
        { bedrijfId: bedrijf.id }
      );
    }
  } catch (error) {
    logger.error('Blog analytics scheduler error:', error);
  }
});

// ============================================
// Start/Stop all cron jobs
// ============================================

const allJobs = [
  { name: 'Publish Scheduler (*/2 min)', job: publishScheduler },
  { name: 'Content Generator (daily 06:00)', job: contentScheduler },
  { name: 'Engagement Sync (*/30 min)', job: engagementScheduler },
  { name: 'Token Refresh (*/6 hours)', job: tokenScheduler },
  { name: 'Weekly Report (Mon 08:00)', job: weeklyReportScheduler },
  { name: 'Blog Auto-Generator (Mon+Thu 07:00)', job: blogAutoGenerator },
  { name: 'Blog Publish (*/5 min)', job: blogPublishScheduler },
  { name: 'Blog Analytics (*/6 hours)', job: blogAnalyticsScheduler },
  { name: 'SEO Sync - Rank Math (2x/day 06:30+18:30)', job: seoSyncScheduler },
];

export function startCronJobs(): void {
  for (const { name, job } of allJobs) {
    job.start();
    logger.info(`â° Cron started: ${name}`);
  }
}

export function stopCronJobs(): void {
  for (const { name, job } of allJobs) {
    job.stop();
    logger.info(`â¹ï¸ Cron stopped: ${name}`);
  }
}
