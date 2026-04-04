import * as cron from 'cron';
import { db } from '../config/directus';
import { logger } from '../utils/logger';
import {
  contentGenerationQueue,
  postPublishQueue,
  engagementSyncQueue,
  tokenRefreshQueue,
  analyticsQueue,
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

// ============================================
// Start/Stop all cron jobs
// ============================================

const allJobs = [
  { name: 'Publish Scheduler (*/2 min)', job: publishScheduler },
  { name: 'Content Generator (daily 06:00)', job: contentScheduler },
  { name: 'Engagement Sync (*/30 min)', job: engagementScheduler },
  { name: 'Token Refresh (*/6 hours)', job: tokenScheduler },
  { name: 'Weekly Report (Mon 08:00)', job: weeklyReportScheduler },
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
