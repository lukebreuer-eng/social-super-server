import { Queue, QueueEvents } from 'bullmq';
import { redis } from '../config/redis';
import { logger } from '../utils/logger';

const connection = { connection: redis };

// ============================================
// Queue Definitions
// ============================================

// 1. Content Generation - AI generates posts
export const contentGenerationQueue = new Queue('content-generation', {
  ...connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

// 2. Post Publishing - Publish approved posts to platforms
export const postPublishQueue = new Queue('post-publish', {
  ...connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  },
});

// 3. Engagement Sync - Pull engagement metrics from platforms
export const engagementSyncQueue = new Queue('engagement-sync', {
  ...connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 30000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 20 },
  },
});

// 4. Token Refresh - Refresh OAuth tokens before expiry
export const tokenRefreshQueue = new Queue('token-refresh', {
  ...connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 60000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 20 },
  },
});

// 5. Lead Processing - Score and process new leads
export const leadProcessingQueue = new Queue('lead-processing', {
  ...connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

// 6. Blog Generation - AI generates blog posts
export const blogGenerationQueue = new Queue('blog-generation', {
  ...connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 20 },
  },
});

// 7. Blog Publishing - Publish approved blogs to WordPress
export const blogPublishQueue = new Queue('blog-publish', {
  ...connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 20 },
  },
});

// 8. Blog Analytics - Sync blog view counts from WordPress
export const blogAnalyticsQueue = new Queue('blog-analytics', {
  ...connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 30000 },
    removeOnComplete: { count: 20 },
    removeOnFail: { count: 10 },
  },
});

// 9. Analytics Reporting - Generate periodic reports
export const analyticsQueue = new Queue('analytics', {
  ...connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 60000 },
    removeOnComplete: { count: 20 },
    removeOnFail: { count: 10 },
  },
});

// ============================================
// Queue Events (for monitoring)
// ============================================

const queues = [
  { name: 'content-generation', queue: contentGenerationQueue },
  { name: 'post-publish', queue: postPublishQueue },
  { name: 'engagement-sync', queue: engagementSyncQueue },
  { name: 'token-refresh', queue: tokenRefreshQueue },
  { name: 'lead-processing', queue: leadProcessingQueue },
  { name: 'blog-generation', queue: blogGenerationQueue },
  { name: 'blog-publish', queue: blogPublishQueue },
  { name: 'blog-analytics', queue: blogAnalyticsQueue },
  { name: 'analytics', queue: analyticsQueue },
];

// Log queue events
for (const { name } of queues) {
  const events = new QueueEvents(name, connection);

  events.on('completed', ({ jobId }) => {
    logger.debug(`Job ${jobId} completed in queue [${name}]`);
  });

  events.on('failed', ({ jobId, failedReason }) => {
    logger.error(`Job ${jobId} failed in queue [${name}]: ${failedReason}`);
  });

  events.on('stalled', ({ jobId }) => {
    logger.warn(`Job ${jobId} stalled in queue [${name}]`);
  });
}

export { queues };

logger.info('✅ BullMQ queues initialized');
