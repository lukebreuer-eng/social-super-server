import express from 'express';
import { z } from 'zod';
import { env } from './config/env';
import { redis } from './config/redis';
import { logger } from './utils/logger';
import { startCronJobs, stopCronJobs } from './scheduler/cron-jobs';
import { shutdownWorkers } from './scheduler/workers';
import { handleOAuthCallback } from './oauth/token-manager';
import { captureLead } from './leads/lead-scorer';
import { leadProcessingQueue } from './scheduler/queues';

// ============================================
// Input Validation Schemas
// ============================================

const generateSchema = z.object({
  bedrijfId: z.number().int().positive(),
  platform: z.enum(['instagram', 'facebook', 'linkedin', 'tiktok']),
  postType: z.enum(['educational', 'promotional', 'engagement', 'behind_the_scenes', 'testimonial', 'regular']).optional().default('regular'),
});

const blogGenerateSchema = z.object({
  bedrijfId: z.number().int().positive(),
  keyword: z.string().min(1).max(200),
  topic: z.string().max(500).optional(),
  targetWordCount: z.number().int().min(300).max(3000).optional().default(1000),
});

const leadSchema = z.object({
  naam: z.string().min(1).max(200),
  email: z.string().email().max(254),
  telefoon: z.string().max(20).optional(),
  bedrijf_naam: z.string().max(200).optional(),
  bedrijfId: z.number().int().positive(),
  bron: z.string().min(1).max(50),
  bron_post: z.number().int().positive().optional(),
  bron_url: z.string().max(2000),
  utm_source: z.string().max(100).optional(),
  utm_medium: z.string().max(100).optional(),
  utm_campaign: z.string().max(200).optional(),
});

// ============================================
// Express App (Health & API endpoints)
// ============================================

const app = express();
app.use(express.json());

// CORS for lead capture from external websites
app.use('/api/leads', (_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health check (unauthenticated - needed for Docker healthcheck)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

// ============================================
// API Key Authentication Middleware
// ============================================

app.use('/api', (req, res, next) => {
  // Public endpoints — no auth required
  if (req.path === '/leads' && req.method === 'POST') {
    return next();
  }

  if (!env.API_KEY) {
    // No API key configured — skip auth (development mode)
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header (Bearer <API_KEY>)' });
  }

  const token = authHeader.slice(7);
  if (token !== env.API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
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
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  }

  const { bedrijfId, platform, postType } = parsed.data;

  const { contentGenerationQueue } = await import('./scheduler/queues');
  const job = await contentGenerationQueue.add(
    `manual-${bedrijfId}-${platform}`,
    { bedrijfId, platform, postType },
    { priority: 1 }
  );

  res.json({ message: 'Content generation queued', jobId: job.id });
});

// Manually trigger blog generation
app.post('/api/blog/generate', async (req, res) => {
  const parsed = blogGenerateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  }

  const { bedrijfId, keyword, topic, targetWordCount } = parsed.data;

  const { blogGenerationQueue } = await import('./scheduler/queues');
  const job = await blogGenerationQueue.add(
    `blog-${bedrijfId}-${keyword}`,
    { bedrijfId, keyword, topic, targetWordCount },
    { priority: 1 }
  );

  res.json({ message: 'Blog generation queued', jobId: job.id });
});

// Blog dashboard
app.get('/api/blog/dashboard/:bedrijfId', async (req, res) => {
  const bedrijfId = parseInt(req.params.bedrijfId);
  if (!bedrijfId || bedrijfId <= 0) {
    return res.status(400).json({ error: 'Valid bedrijfId required' });
  }

  try {
    const { getBlogDashboard } = await import('./blog/blog-analytics');
    const dashboard = await getBlogDashboard(bedrijfId);
    res.json(dashboard);
  } catch (error) {
    logger.error('Blog dashboard error:', error);
    res.status(500).json({ error: 'Failed to load blog dashboard' });
  }
});

// SEO dashboard (Rank Math)
app.get('/api/seo/dashboard/:bedrijfId', async (req, res) => {
  const bedrijfId = parseInt(req.params.bedrijfId);
  if (!bedrijfId || bedrijfId <= 0) {
    return res.status(400).json({ error: 'Valid bedrijfId required' });
  }

  try {
    const { getSEODashboard } = await import('./seo/rankmath-sync');
    const dashboard = await getSEODashboard(bedrijfId);
    res.json(dashboard);
  } catch (error) {
    logger.error('SEO dashboard error:', error);
    res.status(500).json({ error: 'Failed to load SEO dashboard' });
  }
});

// Manual SEO sync trigger
app.post('/api/seo/sync', async (req, res) => {
  const { bedrijfId } = req.body;
  if (!bedrijfId || bedrijfId <= 0) {
    return res.status(400).json({ error: 'Valid bedrijfId required' });
  }

  try {
    const { seoSyncQueue } = await import('./scheduler/queues');
    const job = await seoSyncQueue.add(
      `manual-seo-sync-${bedrijfId}`,
      { bedrijfId },
      { priority: 1 }
    );
    res.json({ message: 'SEO sync queued', jobId: job.id });
  } catch (error) {
    logger.error('SEO sync trigger error:', error);
    res.status(500).json({ error: 'Failed to queue SEO sync' });
  }
});

// Lead capture webhook
app.post('/api/leads', async (req, res) => {
  const parsed = leadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  }

  try {
    const lead = await captureLead(parsed.data);

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
  logger.info('ÃÂ°ÃÂÃÂÃÂ Social Engine starting...');
  logger.info(`Environment: ${env.NODE_ENV}`);
  logger.info(`Directus: ${env.DIRECTUS_URL}`);

  // Clean stale jobs from queues to prevent duplicates after redeploy
  try {
    const { queues } = await import('./scheduler/queues');
    for (const { name, queue } of queues) {
      const waiting = await queue.getWaiting();
      const delayed = await queue.getDelayed();
      const staleJobs = [...waiting, ...delayed];
      if (staleJobs.length > 0) {
        for (const job of staleJobs) {
          await job.remove();
        }
        logger.info(`Cleaned ${staleJobs.length} stale jobs from queue [${name}]`);
      }
    }
  } catch (error) {
    logger.warn('Failed to clean stale queue jobs:', error);
  }

  // Import workers to register them
  await import('./scheduler/workers');

  // Start cron jobs
  (() => { try { startCronJobs(); } catch(e) { logger.warn("Cron jobs failed to start - Redis may not be available:", e); } })();

  // Start Express server
  const port = parseInt(env.PORT);
  app.listen(port, '0.0.0.0', () => {
    logger.info(`ÃÂ°ÃÂÃÂÃÂ API server listening on port ${port}`);
    logger.info('ÃÂ¢ÃÂÃÂ Social Engine fully operational!');
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
