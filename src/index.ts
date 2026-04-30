import express from 'express';
import path from 'path';
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

// Serve dashboard static files (unauthenticated)
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));
app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

// Root redirect to dashboard
app.get('/', (_req, res) => {
  res.redirect('/dashboard');
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
  if (req.path === '/leads/internet' && req.method === 'POST') {
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

// ============================================
// Dashboard API Endpoints
// ============================================

// List posts with filters
app.get('/api/posts', async (req, res) => {
  try {
    const { readItems } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));

    const filter: Record<string, unknown> = {};
    if (req.query.bedrijfId) filter.bedrijf = { _eq: parseInt(req.query.bedrijfId as string) };
    if (req.query.status) filter.approval_status = { _eq: req.query.status as string };
    if (req.query.type) filter.post_type = { _eq: req.query.type as string };

    const fields = [
      'id', 'title', 'post_type', 'approval_status', 'bedrijf', 'date_created',
      'published_at', 'media', 'engagement_likes', 'engagement_comments',
      'engagement_shares', 'engagement_reach', 'seo_score', 'platform_post_url',
    ] as const;

    const { aggregate } = await import('@directus/sdk');
    const countResult = await directus.request(aggregate('Posts', { aggregate: { count: '*' }, query: { filter } as any }));
    const totalCount = parseInt((countResult as any)?.[0]?.count ?? '0', 10);

    const posts = await directus.request(readItems('Posts', {
      fields: fields as any,
      filter,
      sort: ['-date_created'],
      limit,
      offset: (page - 1) * limit,
    }));

    res.json({
      posts,
      meta: {
        total_count: totalCount,
        page,
        pages: Math.ceil(totalCount / limit),
      },
    });
  } catch (error) {
    logger.error('List posts error:', error);
    res.status(500).json({ error: 'Failed to list posts' });
  }
});

// Single post detail
app.get('/api/posts/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: 'Valid post id required' });
  }

  try {
    const { readItem } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');

    const post = await directus.request(readItem('Posts', id));
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json(post);
  } catch (error) {
    logger.error('Get post error:', error);
    res.status(500).json({ error: 'Failed to get post' });
  }
});

// Approve a post
app.patch('/api/posts/:id/approve', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: 'Valid post id required' });
  }

  try {
    const { db } = await import('./config/directus');

    const post = await db.updatePost(id, {
      approval_status: 'approved',
      approved_at: new Date().toISOString(),
    });

    await db.logAction(id, 'approved', 'Post approved via dashboard API', true);

    res.json({ success: true, post });
  } catch (error) {
    logger.error('Approve post error:', error);
    res.status(500).json({ error: 'Failed to approve post' });
  }
});

// Reject a post
const rejectSchema = z.object({
  reason: z.string().min(1).max(1000),
});

app.patch('/api/posts/:id/reject', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: 'Valid post id required' });
  }

  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  }

  try {
    const { db } = await import('./config/directus');

    const post = await db.updatePost(id, {
      approval_status: 'rejected',
      rejection_reason: parsed.data.reason,
    });

    await db.logAction(id, 'rejected', `Post rejected: ${parsed.data.reason}`, true);

    res.json({ success: true, post });
  } catch (error) {
    logger.error('Reject post error:', error);
    res.status(500).json({ error: 'Failed to reject post' });
  }
});

// Update a post (only allowed fields)
const updatePostSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  caption: z.string().max(50000).optional(),
  hashtags: z.array(z.string()).optional(),
  cta_link: z.string().max(2000).optional(),
  cta_text: z.string().max(200).optional(),
  scheduled_at: z.string().datetime().nullable().optional(),
  media: z.string().uuid().nullable().optional(),
  seo_score: z.number().min(0).max(100).nullable().optional(),
  seo_title: z.string().max(500).nullable().optional(),
  seo_description: z.string().max(1000).nullable().optional(),
  seo_focus_keyword: z.string().max(200).nullable().optional(),
});

app.patch('/api/posts/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id <= 0) {
    return res.status(400).json({ error: 'Valid post id required' });
  }

  const parsed = updatePostSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.error(`Post update validation failed for post ${id}:`, {
      body: req.body,
      errors: parsed.error.flatten()
    });
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  }

  if (Object.keys(parsed.data).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  try {
    const { db } = await import('./config/directus');

    const post = await db.updatePost(id, parsed.data as any);

    await db.logAction(id, 'updated', `Post updated fields: ${Object.keys(parsed.data).join(', ')}`, true);

    res.json({ success: true, post });
  } catch (error) {
    logger.error('Update post error:', error);
    res.status(500).json({ error: 'Failed to update post' });
  }
});

// Calendar view
app.get('/api/calendar', async (req, res) => {
  try {
    const { readItems } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');

    const month = req.query.month as string; // YYYY-MM
    const filter: Record<string, unknown> = {};

    if (req.query.bedrijfId) filter.bedrijf = { _eq: parseInt(req.query.bedrijfId as string) };

    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const startDate = `${month}-01T00:00:00.000Z`;
      const [year, mon] = month.split('-').map(Number);
      const endDate = new Date(year, mon, 1).toISOString(); // first day of next month
      filter.date_created = { _gte: startDate, _lt: endDate };
    }

    const posts = await directus.request(readItems('Posts', {
      fields: ['id', 'date_created', 'published_at', 'scheduled_at', 'title', 'approval_status', 'bedrijf', 'post_type'] as any,
      filter,
      sort: ['scheduled_at', 'date_created'],
      limit: -1,
    }));

    res.json({ posts });
  } catch (error) {
    logger.error('Calendar error:', error);
    res.status(500).json({ error: 'Failed to load calendar data' });
  }
});

// Analytics overview (dashboard KPIs)
app.get('/api/analytics/overview', async (req, res) => {
  try {
    const { readItems, aggregate } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');

    const postFilter: Record<string, unknown> = {};
    const leadFilter: Record<string, unknown> = {};
    if (req.query.bedrijfId) {
      const bedrijfId = parseInt(req.query.bedrijfId as string);
      postFilter.bedrijf = { _eq: bedrijfId };
      leadFilter.bedrijf = { _eq: bedrijfId };
    }

    // Run all aggregate queries in parallel
    const [totalPostsResult, publishedResult, pendingResult, leadsResult, seoResult, blogViewsResult] = await Promise.all([
      // Total posts
      directus.request(aggregate('Posts', { aggregate: { count: '*' }, query: { filter: postFilter } as any })),
      // Published posts
      directus.request(aggregate('Posts', {
        aggregate: { count: '*' },
        query: { filter: { ...postFilter, published_at: { _nnull: true } } } as any,
      })),
      // Pending review
      directus.request(aggregate('Posts', {
        aggregate: { count: '*' },
        query: { filter: { ...postFilter, approval_status: { _eq: 'pending_review' } } } as any,
      })),
      // Total leads
      directus.request(aggregate('Leads', { aggregate: { count: '*' }, query: { filter: leadFilter } as any })),
      // Average SEO score
      directus.request(aggregate('Posts', {
        aggregate: { avg: 'seo_score' as any },
        query: { filter: { ...postFilter, seo_score: { _gt: 0 } } } as any,
      })),
      // Total blog views
      directus.request(aggregate('Posts', {
        aggregate: { sum: 'blog_views' as any },
        query: { filter: { ...postFilter, wp_post_id: { _nnull: true } } } as any,
      })),
    ]);

    res.json({
      total_posts: parseInt((totalPostsResult as any)?.[0]?.count ?? '0', 10),
      published: parseInt((publishedResult as any)?.[0]?.count ?? '0', 10),
      pending_review: parseInt((pendingResult as any)?.[0]?.count ?? '0', 10),
      total_leads: parseInt((leadsResult as any)?.[0]?.count ?? '0', 10),
      avg_seo_score: parseFloat((seoResult as any)?.[0]?.avg?.seo_score ?? '0') || 0,
      total_blog_views: parseInt((blogViewsResult as any)?.[0]?.sum?.blog_views ?? '0', 10),
    });
  } catch (error) {
    logger.error('Analytics overview error:', error);
    res.status(500).json({ error: 'Failed to load analytics overview' });
  }
});

// ============================================
// Auth proxy — forwards to Directus to avoid CORS issues
// ============================================

app.post('/api/auth/login', async (req, res) => {
  try {
    const axios = (await import('axios')).default;
    const response = await axios.post(`${env.DIRECTUS_URL}/auth/login`, req.body, {
      headers: { 'Content-Type': 'application/json' },
    });
    res.json(response.data);
  } catch (error: any) {
    const status = error.response?.status || 401;
    const data = error.response?.data || { errors: [{ message: 'Login mislukt' }] };
    res.status(status).json(data);
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const axios = (await import('axios')).default;
    const response = await axios.get(`${env.DIRECTUS_URL}/users/me?fields=first_name,last_name,email,role`, {
      headers: { 'Authorization': req.headers.authorization || '' },
    });
    res.json(response.data);
  } catch (error: any) {
    res.status(401).json({ errors: [{ message: 'Niet ingelogd' }] });
  }
});

// AI Suggestions dashboard
app.get('/api/suggestions/:bedrijfId', async (req, res) => {
  const bedrijfId = parseInt(req.params.bedrijfId);
  if (!bedrijfId || bedrijfId <= 0) {
    return res.status(400).json({ error: 'Valid bedrijfId required' });
  }

  try {
    const { getSuggestionsDashboard } = await import('./ai-engine/suggestion-engine');
    const dashboard = await getSuggestionsDashboard(bedrijfId);
    res.json(dashboard);
  } catch (error) {
    logger.error('Suggestions dashboard error:', error);
    res.status(500).json({ error: 'Failed to load suggestions' });
  }
});

// Generate suggestions manually
app.post('/api/suggestions/generate', async (req, res) => {
  const { bedrijfId } = req.body;
  if (!bedrijfId || bedrijfId <= 0) {
    return res.status(400).json({ error: 'Valid bedrijfId required' });
  }

  try {
    const { suggestionsQueue } = await import('./scheduler/queues');
    const job = await suggestionsQueue.add(
      `manual-suggestions-${bedrijfId}`,
      { bedrijfId },
      { priority: 1 }
    );
    res.json({ message: 'Suggestions generation queued', jobId: job.id });
  } catch (error) {
    logger.error('Suggestions trigger error:', error);
    res.status(500).json({ error: 'Failed to queue suggestions' });
  }
});

// Get leads list (for dashboard)
app.get('/api/leads/list', async (req, res) => {
  const bedrijfId = parseInt(req.query.bedrijfId as string);
  if (!bedrijfId || bedrijfId <= 0) {
    return res.status(400).json({ error: 'Valid bedrijfId required' });
  }

  try {
    const { directus } = await import('./config/directus');
    const { readItems } = await import('@directus/sdk');

    const leads = await directus.request(
      readItems('Leads', {
        filter: { bedrijf: { _eq: bedrijfId } },
        limit: 100,
      })
    ) as any;

    res.json({ data: leads });
  } catch (error) {
    logger.error('Leads list error:', error);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// Get lead activity
app.get('/api/leads/:id/activity', async (req, res) => {
  const leadId = parseInt(req.params.id);
  if (!leadId || leadId <= 0) {
    return res.status(400).json({ error: 'Valid lead id required' });
  }

  try {
    const { directus } = await import('./config/directus');
    const { readItems } = await import('@directus/sdk');

    const activities = await directus.request(
      readItems('Lead_Activity', {
        filter: { lead: { _eq: leadId } },
      })
    ) as any;

    res.json({ data: activities });
  } catch (error) {
    logger.error('Lead activity error:', error);
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
});

// Add lead activity
app.post('/api/leads/:id/activity', async (req, res) => {
  const leadId = parseInt(req.params.id);
  if (!leadId || leadId <= 0) {
    return res.status(400).json({ error: 'Valid lead id required' });
  }

  try {
    const { directus } = await import('./config/directus');
    const { createItem } = await import('@directus/sdk');

    const activity = await directus.request(
      createItem('Lead_Activity', {
        lead: leadId,
        ...req.body,
      })
    ) as any;

    res.json({ data: activity });
  } catch (error) {
    logger.error('Add lead activity error:', error);
    res.status(500).json({ error: 'Failed to add activity' });
  }
});

// Update lead
app.patch('/api/leads/:id', async (req, res) => {
  const leadId = parseInt(req.params.id);
  if (!leadId || leadId <= 0) {
    return res.status(400).json({ error: 'Valid lead id required' });
  }

  try {
    const { directus } = await import('./config/directus');
    const { updateItem } = await import('@directus/sdk');

    const lead = await directus.request(
      updateItem('Leads', leadId, req.body)
    );

    res.json({ data: lead });
  } catch (error) {
    logger.error('Update lead error:', error);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

// Delete lead
app.delete('/api/leads/:id', async (req, res) => {
  const leadId = parseInt(req.params.id);
  if (!leadId || leadId <= 0) {
    return res.status(400).json({ error: 'Valid lead id required' });
  }

  try {
    const { directus } = await import('./config/directus');
    const { deleteItem } = await import('@directus/sdk');

    await directus.request(
      deleteItem('Leads', leadId)
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('Delete lead error:', error);
    res.status(500).json({ error: 'Failed to delete lead' });
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

// Internet lead webhook (from WordPress plugin)
app.post('/api/leads/internet', async (req, res) => {
  try {
    // API key authentication
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

    if (!apiKey || apiKey !== env.WEBHOOK_API_KEY) {
      logger.warn('Unauthorized internet lead webhook attempt');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { leadId } = req.body;

    if (!leadId) {
      return res.status(400).json({ error: 'leadId required' });
    }

    logger.info(`Internet lead webhook received for lead ${leadId}`);

    // Import and trigger internet lead handler
    const { handleInternetLead } = await import('./leads/internet-lead-handler');

    // Queue the lead processing (async, don't wait)
    handleInternetLead(leadId).catch(error => {
      logger.error(`Internet lead processing failed for ${leadId}:`, error);
    });

    // Return immediately
    res.json({
      success: true,
      leadId,
      message: 'Internet lead processing started'
    });

  } catch (error) {
    logger.error('Internet lead webhook error:', error);
    res.status(500).json({ error: 'Failed to process internet lead' });
  }
});

// Get media files from Directus
app.get('/api/media', async (req, res) => {
  try {
    const { directus } = await import('./config/directus');
    const { readFiles } = await import('@directus/sdk');

    const files = await directus.request(
      readFiles({
        filter: {
          type: { _starts_with: 'image' }
        },
        limit: 100,
        sort: ['-uploaded_on'],
        fields: ['id', 'title', 'filename_download', 'type', 'uploaded_on']
      })
    );

    res.json({ data: files });
  } catch (error) {
    logger.error('Media list error:', error);
    res.status(500).json({ error: 'Failed to fetch media' });
  }
});

// Proxy Directus assets (to avoid 403)
app.get('/api/assets/:fileId', async (req, res) => {
  const { fileId } = req.params;

  try {
    const { directus } = await import('./config/directus');
    const { readAssetRaw } = await import('@directus/sdk');

    // Forward query params (width, height, fit, etc.)
    const assetStream = await directus.request(
      readAssetRaw(fileId, {
        ...req.query as Record<string, string>
      })
    );

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000');

    // Convert ReadableStream to Buffer
    const chunks: Uint8Array[] = [];
    const reader = assetStream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks);
    res.send(buffer);
  } catch (error) {
    logger.error('Asset proxy error:', error);
    res.status(404).send('Asset not found');
  }
});

// Generate AI image for post
app.post('/api/generate-image', async (req, res) => {
  const parsed = z.object({
    prompt: z.string().min(1).max(500),
    bedrijfId: z.number().int().positive(),
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  }

  const { prompt, bedrijfId } = parsed.data;

  try {
    const { db } = await import('./config/directus');

    // Get bedrijf details
    const bedrijf = await db.getBedrijf(bedrijfId);
    if (!bedrijf) {
      return res.status(404).json({ error: 'Bedrijf not found' });
    }

    const { generateImage } = await import('./visual-engine/image-generator');

    logger.info(`Generating AI image for bedrijf ${bedrijfId}: ${prompt}`);

    const result = await generateImage(bedrijf, { title: prompt });

    // Upload to Directus and return media ID
    res.json({ success: true, mediaId: result.directusFileId });
  } catch (error) {
    logger.error('Image generation error:', error);
    res.status(500).json({ error: 'Failed to generate image' });
  }
});

// ============================================
// Competitors API
// ============================================

// Get competitors for a bedrijf
app.get('/api/competitors', async (req, res) => {
  const bedrijfId = parseInt(req.query.bedrijfId as string);

  if (!bedrijfId || isNaN(bedrijfId)) {
    return res.status(400).json({ error: 'Invalid bedrijfId' });
  }

  try {
    const { directus } = await import('./config/directus');
    const { readItems } = await import('@directus/sdk');

    const competitors = await directus.request(
      readItems('Competitors', {
        filter: {
          bedrijf: { _eq: bedrijfId }
        },
        sort: ['-date_created']
      })
    );

    res.json({ data: competitors });
  } catch (error) {
    logger.error('Competitors fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch competitors' });
  }
});

// Create competitor
app.post('/api/competitors', async (req, res) => {
  const parsed = z.object({
    naam: z.string().min(1).max(200),
    bedrijf: z.number().int().positive(),
    platform: z.string().max(50).optional(),
    profile_url: z.string().max(500).optional(),
    follower_count: z.number().int().min(0).optional(),
    notes: z.string().max(2000).optional(),
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  }

  try {
    const { directus } = await import('./config/directus');
    const { createItem } = await import('@directus/sdk');

    const competitor = await directus.request(
      createItem('Competitors', parsed.data)
    );

    res.json({ success: true, data: competitor });
  } catch (error) {
    logger.error('Competitor create error:', error);
    res.status(500).json({ error: 'Failed to create competitor' });
  }
});

// Delete competitor
app.delete('/api/competitors/:id', async (req, res) => {
  const id = parseInt(req.params.id);

  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'Invalid competitor ID' });
  }

  try {
    const { directus } = await import('./config/directus');
    const { deleteItem } = await import('@directus/sdk');

    await directus.request(
      deleteItem('Competitors', id)
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('Competitor delete error:', error);
    res.status(500).json({ error: 'Failed to delete competitor' });
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
