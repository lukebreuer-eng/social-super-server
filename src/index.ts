import express from 'express';
import { env } from './config/env';
import { redis } from './config/redis';
import { directus, db } from './config/directus';
import { logger } from './utils/logger';
import { startCronJobs, stopCronJobs } from './scheduler/cron-jobs';
import { shutdownWorkers } from './scheduler/workers';
import { handleOAuthCallback } from './oauth/token-manager';
import { captureLead } from './leads/lead-scorer';
import { leadProcessingQueue } from './scheduler/queues';

// ============================================
// Express App (Health & API endpoints)
// ============================================

const app = express();
app.use(express.json());

// Health check
app.get('/health', async (_req, res) => {
  try {
    // Check Redis
    const redisPing = await redis.ping();

    // Check Directus
    const bedrijven = await db.getBedrijven();

    res.json({
      status: 'healthy',
      service: 'social-engine',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks: {
        redis: redisPing === 'PONG' ? 'ok' : 'error',
        directus: bedrijven.length >= 0 ? 'ok' : 'error',
        bedrijven_count: bedrijven.length,
      },
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Queue status
app.get('/api/queues', async (_req, res) => {
  const { queues } = await import('./scheduler/queues');

  const status = await Promise.all(
    queues.map(async ({ name, queue }) => ({
      name,
      waiting: await queue.getWaitingCount(),
      active: await queue.getActiveCount(),
      completed: await queue.getCompletedCount(),
      failed: await queue.getFailedCount(),
      delayed: await queue.getDelayedCount(),
    }))
  );

  res.json({ queues: status });
});

// Manually trigger content generation
app.post('/api/generate', async (req, res) => {
  const { bedrijfId, platform, postType } = req.body;

  if (!bedrijfId || !platform) {
    return res.status(400).json({ error: 'bedrijfId and platform required' });
  }

  const { contentGenerationQueue } = await import('./scheduler/queues');
  const job = await contentGenerationQueue.add(
    `manual-${bedrijfId}-${platform}`,
    { bedrijfId, platform, postType: postType || 'regular' },
    { priority: 1 }
  );

  res.json({ message: 'Content generation queued', jobId: job.id });
});

// Lead capture webhook
app.post('/api/leads', async (req, res) => {
  try {
    const lead = await captureLead(req.body);

    // Queue lead scoring
    await leadProcessingQueue.add(
      `score-${lead.id}`,
      { leadId: lead.id }
    );

    res.json({ success: true, leadId: lead.id });
  } catch (error) {
    logger.error('Lead capture error:', error);
    res.status(500).json({ error: 'Failed to capture lead' });
  }
});

// OAuth callbacks
app.get('/oauth/:platform/callback', async (req, res) => {
  const { platform } = req.params;
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'Authorization code required' });
  }

  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/oauth/${platform}/callback`;
    const tokens = await handleOAuthCallback(platform, code as string, redirectUri);

    res.json({
      success: true,
      platform,
      message: 'OAuth successful. Save these tokens to your Social Account in Directus.',
      userId: tokens.userId,
      expiresIn: tokens.expiresIn,
    });
  } catch (error) {
    logger.error(`OAuth callback error (${platform}):`, error);
    res.status(500).json({ error: 'OAuth callback failed' });
  }
});

// ============================================
// Startup
// ============================================

async function start(): Promise<void> {
  logger.info('ð Social Engine starting...');
  logger.info(`Environment: ${env.NODE_ENV}`);
  logger.info(`Directus: ${env.DIRECTUS_URL}`);

  // Import workers to register them
  await import('./scheduler/workers');

  // Start cron jobs
  (() => { try { startCronJobs(); } catch(e) { logger.warn("Cron jobs failed to start - Redis may not be available:", e); } })();

  // Start Express server
  const port = parseInt(env.PORT);
  app.listen(port, '0.0.0.0', () => {
    logger.info(`ð API server listening on port ${port}`);
    logger.info('â Social Engine fully operational!');
  });
}

// ============================================
// Graceful Shutdown
// ============================================

async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received. Starting graceful shutdown...`);

  stopCronJobs();
  await shutdownWorkers();
  await redis.quit();

  logger.info('Shutdown complete. Goodbye!');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

// Start the engine!
start().catch((error) => {
  logger.error('Fatal startup error:', error);
  process.exit(1);
});
