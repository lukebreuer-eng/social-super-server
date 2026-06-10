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

// Theorie sidekick app (statisch, unauthenticated)
app.use('/theorie', express.static(path.join(__dirname, 'theorie-app')));
app.get('/theorie', (_req, res) => {
  res.sendFile(path.join(__dirname, 'theorie-app', 'index.html'));
});

// Subdomein routing: theorie.ipaudio.nl moet direct de theorie-app serveren
// vanaf root, zonder /theorie path
app.use((req, res, next) => {
  const host = (req.hostname || req.headers.host || '').toLowerCase();
  if (host.startsWith('theorie.')) {
    // API calls via subdomein doorgeven naar /api/theorie/*
    if (req.path.startsWith('/api/theorie')) return next();
    if (req.path === '/' || req.path === '') {
      return res.sendFile(path.join(__dirname, 'theorie-app', 'index.html'));
    }
    // Static asset: serve uit theorie-app
    if (req.path.startsWith('/manifest.json') || req.path.startsWith('/sw.js') || req.path.startsWith('/icon-')) {
      return res.sendFile(path.join(__dirname, 'theorie-app', req.path.replace(/^\//, '')));
    }
  }
  next();
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
  // Theorie sidekick (Miles): geen auth, draait op zijn telefoon zonder API key
  if (req.path.startsWith('/theorie')) {
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
      'published_at', 'scheduled_at', 'media', 'engagement_likes', 'engagement_comments',
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
    })) as any[];

    // Transform field names for dashboard compatibility
    const transformedPosts = posts.map(p => ({
      ...p,
      bedrijf_id: p.bedrijf,
      type: p.post_type,
      status: p.approval_status,
    }));

    res.json({
      posts: transformedPosts,
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
    })) as any[];

    // Transform field names for dashboard compatibility
    const transformedPosts = posts.map(p => ({
      ...p,
      bedrijf_id: p.bedrijf,
      type: p.post_type,
      status: p.approval_status,
    }));

    res.json({ posts: transformedPosts });
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
    const { readFiles, readFolders } = await import('@directus/sdk');

    // Get bedrijfId from query (optional)
    const bedrijfId = req.query.bedrijfId ? parseInt(req.query.bedrijfId as string) : null;

    let filter: any = {
      type: { _starts_with: 'image' }
    };

    // If bedrijfId provided, try to filter by folder
    if (bedrijfId) {
      try {
        // Get all folders to find the bedrijf folder
        const folders = await directus.request(readFolders({
          fields: ['id', 'name']
        }));

        // Find folder matching bedrijf (assuming folder name contains bedrijf name)
        const { db } = await import('./config/directus');
        const bedrijf = await db.getBedrijf(bedrijfId);
        const bedrijfFolder = folders.find((f: any) =>
          f.name && bedrijf?.title && f.name.toLowerCase().includes(bedrijf.title.toLowerCase())
        );

        if (bedrijfFolder) {
          filter.folder = { _eq: bedrijfFolder.id };
        }
      } catch (err) {
        logger.warn('Could not filter media by bedrijf folder:', err);
        // Continue without folder filter
      }
    }

    const files = await directus.request(
      readFiles({
        filter,
        limit: 100,
        sort: ['-uploaded_on'],
        fields: ['id', 'title', 'filename_download', 'type', 'uploaded_on', 'folder']
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

// ============================================
// Knowledge Base API
// ============================================

const KB_TYPE_PRESETS = [
  { value: 'faq', label: 'FAQ — algemene vraag/antwoord' },
  { value: 'service_details', label: 'Dienst details — wat zit incl/excl' },
  { value: 'logistics', label: 'Logistiek — levergebied, set-up, ruimte, stroom' },
  { value: 'pricing', label: 'Prijzen — model, indicaties, supplementen' },
  { value: 'availability', label: 'Beschikbaarheid — seizoen, last-minute, weer' },
  { value: 'policies', label: 'Voorwaarden — annulering, weergarantie, borg' },
  { value: 'dietary', label: 'Dieet — vegan, lactosevrij, allergenen' },
  { value: 'products', label: 'Producten — wagens, smaken, opties' },
  { value: 'company_profile', label: 'Over het bedrijf' },
  { value: 'tone_of_voice', label: 'Tone of voice' },
  { value: 'target_audience', label: 'Doelgroep' },
  { value: 'content_rules', label: 'Content regels — wat wel/niet zeggen' },
  { value: 'market_context', label: 'Marktcontext / concurrenten' },
  { value: 'operations', label: 'Operationeel' },
  { value: 'competitor_intel', label: 'Concurrent intelligence' },
  { value: 'seo_status', label: 'SEO status' },
  { value: 'seo_keywords', label: 'SEO keywords' },
  { value: 'linkbuilding', label: 'Linkbuilding' },
  { value: 'google_business', label: 'Google Business' },
];

app.get('/api/knowledge/types', (_req, res) => {
  res.json({ types: KB_TYPE_PRESETS });
});

app.get('/api/knowledge', async (req, res) => {
  try {
    const { readItems, aggregate } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 100));

    const filter: Record<string, unknown> = {};
    if (req.query.bedrijfId) filter.bedrijf = { _eq: parseInt(req.query.bedrijfId as string) };
    if (req.query.type) filter.knowledge_type = { _eq: req.query.type as string };
    if (req.query.q) {
      const q = req.query.q as string;
      filter._or = [
        { title: { _icontains: q } },
        { content: { _icontains: q } },
      ];
    }

    const countResult = await directus.request(aggregate('AI_Knowledge_Base', { aggregate: { count: '*' }, query: { filter } as any }));
    const totalCount = parseInt((countResult as any)?.[0]?.count ?? '0', 10);

    const entries = await directus.request(readItems('AI_Knowledge_Base', {
      filter,
      sort: ['knowledge_type', '-date_updated'],
      limit,
      offset: (page - 1) * limit,
    })) as any[];

    res.json({
      entries,
      meta: { total_count: totalCount, page, pages: Math.ceil(totalCount / limit) },
    });
  } catch (error) {
    logger.error('List KB error:', error);
    res.status(500).json({ error: 'Failed to list knowledge base' });
  }
});

app.get('/api/knowledge/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id <= 0) return res.status(400).json({ error: 'Valid id required' });
  try {
    const { readItem } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');
    const entry = await directus.request(readItem('AI_Knowledge_Base', id));
    res.json(entry);
  } catch (error) {
    logger.error('Get KB error:', error);
    res.status(500).json({ error: 'Failed to get entry' });
  }
});

const kbCreateSchema = z.object({
  bedrijf: z.number().int().positive(),
  knowledge_type: z.string().min(1).max(50),
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(20000),
  source: z.string().max(500).optional().nullable(),
  relevance_score: z.number().int().min(1).max(10).optional().default(1),
});

app.post('/api/knowledge', async (req, res) => {
  const parsed = kbCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  }
  try {
    const { createItem } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');
    const created = await directus.request(createItem('AI_Knowledge_Base', parsed.data));
    res.json({ success: true, entry: created });
  } catch (error) {
    logger.error('Create KB error:', error);
    res.status(500).json({ error: 'Failed to create entry' });
  }
});

const kbUpdateSchema = z.object({
  knowledge_type: z.string().min(1).max(50).optional(),
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).max(20000).optional(),
  source: z.string().max(500).optional().nullable(),
  relevance_score: z.number().int().min(1).max(10).optional(),
});

app.patch('/api/knowledge/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id <= 0) return res.status(400).json({ error: 'Valid id required' });
  const parsed = kbUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  }
  try {
    const { updateItem } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');
    const updated = await directus.request(updateItem('AI_Knowledge_Base', id, parsed.data));
    res.json({ success: true, entry: updated });
  } catch (error) {
    logger.error('Update KB error:', error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

app.delete('/api/knowledge/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id <= 0) return res.status(400).json({ error: 'Valid id required' });
  try {
    const { deleteItem } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');
    await directus.request(deleteItem('AI_Knowledge_Base', id));
    res.json({ success: true });
  } catch (error) {
    logger.error('Delete KB error:', error);
    res.status(500).json({ error: 'Failed to delete entry' });
  }
});

// Test KB: laat de email-agent een hypothetische klantvraag beantwoorden op basis van de huidige KB
const kbTestSchema = z.object({
  bedrijfId: z.number().int().positive(),
  fromEmail: z.string().email().max(254).optional().default('test@example.com'),
  fromName: z.string().max(200).optional().default('Test Klant'),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(8000),
});

app.post('/api/knowledge/test', async (req, res) => {
  const parsed = kbTestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  }
  try {
    const { generateEmailReply } = await import('./ai-engine/email-agent');
    const draft = await generateEmailReply(parsed.data.bedrijfId, {
      fromEmail: parsed.data.fromEmail,
      fromName: parsed.data.fromName,
      subject: parsed.data.subject,
      bodyPlain: parsed.data.body,
      receivedAt: new Date(),
    });
    res.json({ draft });
  } catch (error: any) {
    logger.error('KB test error:', error);
    res.status(500).json({ error: error?.message || 'Test failed' });
  }
});

// ============================================
// Theorie Sidekick API (Miles bromfiets oefenapp)
// ============================================

// CORS open op /api/theorie zodat ook subdomein theorie.ipaudio.nl kan praten
app.use('/api/theorie', (_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/api/theorie/categorieen', async (_req, res) => {
  try {
    const { readItems, aggregate } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');
    const counts = await directus.request(aggregate('Theorie_Vragen', {
      aggregate: { count: '*' },
      query: { filter: { status: { _eq: 'active' } }, groupBy: ['categorie'] } as any,
    } as any));
    res.json({ categorieen: counts });
  } catch (error) {
    logger.error('Theorie categorieen error:', error);
    res.status(500).json({ error: 'Kon categorieen niet ophalen' });
  }
});

app.post('/api/theorie/sessie/start', async (req, res) => {
  try {
    const { createItem } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');
    const gebruiker = (req.body?.gebruiker as string) || 'miles';
    const categorie = (req.body?.categorie as string) || 'mix';

    // Vandaag al een sessie gedaan? streak ophogen, anders dag 1
    const { readItems } = await import('@directus/sdk');
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const yesterdayStart = new Date(start.getTime() - 86400000);

    const recentSessies = await directus.request(readItems('Theorie_Sessies', {
      filter: { gebruiker: { _eq: gebruiker }, afgerond: { _eq: true } } as any,
      sort: ['-date_created'] as any,
      limit: 1,
      fields: ['streak_dag', 'date_created'] as any,
    })) as Array<{ streak_dag: number; date_created: string }>;

    let streak = 1;
    if (recentSessies[0]) {
      const last = new Date(recentSessies[0].date_created);
      if (last >= yesterdayStart && last < start) streak = (recentSessies[0].streak_dag || 0) + 1;
      else if (last >= start) streak = recentSessies[0].streak_dag || 1;
    }

    const sessie = await directus.request(createItem('Theorie_Sessies', {
      gebruiker,
      categorie_focus: categorie,
      streak_dag: streak,
      afgerond: false,
    })) as any;

    res.json({ sessie_id: sessie.id, streak });
  } catch (error) {
    logger.error('Theorie sessie start error:', error);
    res.status(500).json({ error: 'Kon sessie niet starten' });
  }
});

app.get('/api/theorie/volgende', async (req, res) => {
  try {
    const gebruiker = (req.query.gebruiker as string) || 'miles';
    const categorie = req.query.categorie as string | undefined;
    const exclude = ((req.query.exclude as string) || '')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => n > 0);

    const { selecteerVolgendeVraag } = await import('./theorie/spaced-repetition');
    const pick = await selecteerVolgendeVraag(gebruiker, categorie, exclude);
    if (!pick) return res.status(404).json({ error: 'Geen vragen meer beschikbaar' });

    const { readItem } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');
    const vraag = await directus.request(readItem('Theorie_Vragen', pick.id)) as any;
    if (!vraag) return res.status(404).json({ error: 'Vraag niet gevonden' });

    // Stuur antwoorden zonder "correct" veld — anders kan klant zelf het antwoord lezen
    const safeAntwoorden = ((vraag.antwoorden as any[]) || []).map((a, idx) => ({
      idx,
      tekst: a.tekst,
    }));

    res.json({
      vraag: {
        id: vraag.id,
        categorie: vraag.categorie,
        sub_onderwerp: vraag.sub_onderwerp,
        moeilijkheid: vraag.moeilijkheid,
        vraag: vraag.vraag,
        vraag_kort: vraag.vraag_kort,
        antwoorden: safeAntwoorden,
        visual_type: vraag.visual_type,
        visual_data: vraag.visual_data,
        ezelsbruggetje_preview: vraag.ezelsbruggetje ? true : false,
      },
      reden: pick.reason,
    });
  } catch (error) {
    logger.error('Theorie volgende vraag error:', error);
    res.status(500).json({ error: 'Kon vraag niet ophalen' });
  }
});

const pogingSchema = z.object({
  vraag_id: z.number().int().positive(),
  sessie_id: z.number().int().positive(),
  gebruiker: z.string().default('miles'),
  gekozen_antwoord_index: z.number().int().min(0).max(10),
  tijd_seconden: z.number().int().min(0).max(600).optional(),
});

app.post('/api/theorie/poging', async (req, res) => {
  const parsed = pogingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  }

  try {
    const { readItem, createItem, updateItem } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');

    const vraag = await directus.request(readItem('Theorie_Vragen', parsed.data.vraag_id)) as any;
    if (!vraag) return res.status(404).json({ error: 'Vraag niet gevonden' });

    const antwoorden = (vraag.antwoorden as any[]) || [];
    const gekozen = antwoorden[parsed.data.gekozen_antwoord_index];
    const correct = !!(gekozen && gekozen.correct);
    const correctIdx = antwoorden.findIndex((a) => a.correct);

    // Poging opslaan
    await directus.request(createItem('Theorie_Pogingen', {
      vraag: parsed.data.vraag_id,
      sessie: parsed.data.sessie_id,
      gebruiker: parsed.data.gebruiker,
      gekozen_antwoord_index: parsed.data.gekozen_antwoord_index,
      correct,
      tijd_seconden: parsed.data.tijd_seconden ?? null,
      categorie: vraag.categorie,
      sub_onderwerp: vraag.sub_onderwerp,
    }));

    // Stats bijhouden op vraag (best effort)
    try {
      await directus.request(updateItem('Theorie_Vragen', parsed.data.vraag_id, {
        keer_getoond: (vraag.keer_getoond || 0) + 1,
        keer_correct: (vraag.keer_correct || 0) + (correct ? 1 : 0),
      }));
    } catch (err) {
      logger.warn('Theorie stats update failed:', err);
    }

    // Sessie stats updaten
    try {
      const sessie = await directus.request(readItem('Theorie_Sessies', parsed.data.sessie_id)) as any;
      if (sessie) {
        const vragen_gedaan = (sessie.vragen_gedaan || 0) + 1;
        const correct_count = (sessie.correct_count || 0) + (correct ? 1 : 0);
        const score_percentage = Math.round((correct_count / vragen_gedaan) * 100);
        await directus.request(updateItem('Theorie_Sessies', parsed.data.sessie_id, {
          vragen_gedaan,
          correct_count,
          score_percentage,
        }));
      }
    } catch (err) {
      logger.warn('Theorie sessie update failed:', err);
    }

    res.json({
      correct,
      correct_index: correctIdx,
      uitleg: correct ? vraag.uitleg_correct : (gekozen?.uitleg_bij_fout || `Nope — het juiste antwoord was: "${antwoorden[correctIdx]?.tekst || '?'}".`),
      ezelsbruggetje: vraag.ezelsbruggetje || null,
    });
  } catch (error) {
    logger.error('Theorie poging error:', error);
    res.status(500).json({ error: 'Kon poging niet opslaan' });
  }
});

app.post('/api/theorie/sessie/:id/afronden', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id <= 0) return res.status(400).json({ error: 'Valid sessie id required' });
  try {
    const { updateItem, readItem } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');
    const duur = parseInt(req.body?.duur_seconden) || 0;
    const sessie = await directus.request(updateItem('Theorie_Sessies', id, {
      afgerond: true,
      duur_seconden: duur,
    })) as any;
    res.json({ success: true, sessie });
  } catch (error) {
    logger.error('Theorie sessie afronden error:', error);
    res.status(500).json({ error: 'Kon sessie niet afronden' });
  }
});

/**
 * Analyse-endpoint: zoek het patroon achter Miles' fouten.
 * Beantwoordt vraag: zijn plaatjes-vragen het probleem (hypothese), of iets anders?
 */
app.get('/api/theorie/analyse', async (req, res) => {
  try {
    const gebruiker = (req.query.gebruiker as string) || 'miles';
    const { readItems } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');

    const pogingen = await directus.request(readItems('Theorie_Pogingen', {
      filter: { gebruiker: { _eq: gebruiker } } as any,
      fields: ['vraag', 'correct', 'tijd_seconden', 'categorie', 'sub_onderwerp', 'date_created'] as any,
      limit: 5000,
    })) as Array<{ vraag: number; correct: boolean; tijd_seconden: number | null; categorie: string; sub_onderwerp: string | null; date_created: string }>;

    if (pogingen.length === 0) {
      return res.json({ message: 'Nog geen pogingen. Doe eerst 1-2 sessies.', pogingen: 0 });
    }

    const vraagIds = [...new Set(pogingen.map((p) => p.vraag))];
    const vragen = await directus.request(readItems('Theorie_Vragen', {
      filter: { id: { _in: vraagIds } } as any,
      fields: ['id', 'visual_type', 'moeilijkheid', 'categorie', 'sub_onderwerp'] as any,
      limit: 500,
    })) as Array<{ id: number; visual_type: string; moeilijkheid: number; categorie: string; sub_onderwerp: string }>;
    const vraagMap = new Map(vragen.map((v) => [v.id, v]));

    // Split: visueel (sign/intersection/road/svg) vs tekst-only (none)
    const visueel = pogingen.filter((p) => {
      const v = vraagMap.get(p.vraag);
      return v && v.visual_type && v.visual_type !== 'none';
    });
    const tekstOnly = pogingen.filter((p) => {
      const v = vraagMap.get(p.vraag);
      return v && (!v.visual_type || v.visual_type === 'none');
    });

    function summarize(arr: typeof pogingen, label: string) {
      const totaal = arr.length;
      const goed = arr.filter((p) => p.correct).length;
      const fout = totaal - goed;
      const pct = totaal > 0 ? Math.round((goed / totaal) * 100) : 0;
      const tijdGoed = arr.filter((p) => p.correct && p.tijd_seconden != null).map((p) => p.tijd_seconden!);
      const tijdFout = arr.filter((p) => !p.correct && p.tijd_seconden != null).map((p) => p.tijd_seconden!);
      const avg = (a: number[]) => a.length > 0 ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0;
      return {
        label,
        totaal,
        goed,
        fout,
        percentage: pct,
        gemiddelde_tijd_goed_sec: avg(tijdGoed),
        gemiddelde_tijd_fout_sec: avg(tijdFout),
      };
    }

    const perCategorie: Record<string, ReturnType<typeof summarize>> = {};
    for (const cat of [...new Set(pogingen.map((p) => p.categorie))]) {
      perCategorie[cat] = summarize(pogingen.filter((p) => p.categorie === cat), cat);
    }

    const perVisualType: Record<string, ReturnType<typeof summarize>> = {};
    const typesGevonden = [...new Set(pogingen.map((p) => vraagMap.get(p.vraag)?.visual_type || 'none'))];
    for (const t of typesGevonden) {
      perVisualType[t] = summarize(
        pogingen.filter((p) => (vraagMap.get(p.vraag)?.visual_type || 'none') === t),
        t,
      );
    }

    // Per sub-onderwerp — alleen die met genoeg pogingen
    const perSubOnderwerp: Record<string, ReturnType<typeof summarize>> = {};
    const subs = [...new Set(pogingen.map((p) => p.sub_onderwerp).filter(Boolean))] as string[];
    for (const sub of subs) {
      const subPogingen = pogingen.filter((p) => p.sub_onderwerp === sub);
      if (subPogingen.length >= 2) perSubOnderwerp[sub] = summarize(subPogingen, sub);
    }

    // Snelle klikkers — antwoorden onder 5 sec
    const snel = pogingen.filter((p) => (p.tijd_seconden ?? 999) < 5);
    const langzaam = pogingen.filter((p) => (p.tijd_seconden ?? 0) >= 30);

    const conclusie: string[] = [];

    const visueelDelta = visueel.length >= 3 && tekstOnly.length >= 3
      ? (visueel[0] ? summarize(visueel, 'v').percentage : 0) - summarize(tekstOnly, 't').percentage
      : null;

    if (visueelDelta !== null) {
      if (visueelDelta < -15) {
        conclusie.push(`Bevestigd: plaatjes-vragen zijn ${Math.abs(visueelDelta)}% slechter dan tekst-only. Miles' eigen diagnose klopt — visualiseren is het probleem.`);
      } else if (visueelDelta > 15) {
        conclusie.push(`Verrassend: plaatjes-vragen gaan juist beter dan tekst-only. Misschien is het tekst-interpretatie ipv visueel.`);
      } else {
        conclusie.push(`Plaatjes vs tekst: vergelijkbaar (${visueelDelta} verschil). Probleem zit niet primair in plaatjes.`);
      }
    } else {
      conclusie.push('Nog te weinig data — doe minstens 3 visuele + 3 tekst-only vragen.');
    }

    if (snel.length > 0) {
      const snelPct = Math.round((snel.filter((p) => p.correct).length / snel.length) * 100);
      conclusie.push(`Snelle klikkers (<5 sec): ${snel.length} pogingen, ${snelPct}% goed.`);
    }

    if (langzaam.length > 0) {
      const langPct = Math.round((langzaam.filter((p) => p.correct).length / langzaam.length) * 100);
      conclusie.push(`Lang nadenken (>=30 sec): ${langzaam.length} pogingen, ${langPct}% goed.`);
    }

    // Sub-onderwerp ranking (slechtste eerst)
    const subRanking = Object.values(perSubOnderwerp)
      .sort((a, b) => a.percentage - b.percentage)
      .slice(0, 5);

    res.json({
      gebruiker,
      totaal_pogingen: pogingen.length,
      visueel_vs_tekst: {
        visueel: summarize(visueel, 'met_plaatje'),
        tekst_only: summarize(tekstOnly, 'zonder_plaatje'),
        verschil_in_procent: visueelDelta,
      },
      per_categorie: perCategorie,
      per_visual_type: perVisualType,
      top_5_zwakste_subonderwerpen: subRanking,
      snel_vs_langzaam: {
        snel_lt_5sec: summarize(snel, 'snel'),
        langzaam_ge_30sec: summarize(langzaam, 'langzaam'),
      },
      conclusie,
    });
  } catch (error) {
    logger.error('Theorie analyse error:', error);
    res.status(500).json({ error: 'Kon analyse niet uitvoeren' });
  }
});

app.get('/api/theorie/stats', async (req, res) => {
  try {
    const gebruiker = (req.query.gebruiker as string) || 'miles';
    const { readItems, aggregate } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');

    const sessies = await directus.request(readItems('Theorie_Sessies', {
      filter: { gebruiker: { _eq: gebruiker } } as any,
      sort: ['-date_created'] as any,
      limit: 30,
      fields: ['id', 'vragen_gedaan', 'correct_count', 'score_percentage', 'streak_dag', 'date_created', 'afgerond'] as any,
    })) as any[];

    const pogingen = await directus.request(readItems('Theorie_Pogingen', {
      filter: { gebruiker: { _eq: gebruiker } } as any,
      fields: ['categorie', 'correct'] as any,
      limit: 5000,
    })) as Array<{ categorie: string; correct: boolean }>;

    const perCategorie: Record<string, { totaal: number; goed: number; percentage: number }> = {};
    for (const p of pogingen) {
      const c = perCategorie[p.categorie] || { totaal: 0, goed: 0, percentage: 0 };
      c.totaal += 1;
      if (p.correct) c.goed += 1;
      perCategorie[p.categorie] = c;
    }
    for (const c of Object.keys(perCategorie)) {
      perCategorie[c].percentage = Math.round((perCategorie[c].goed / perCategorie[c].totaal) * 100);
    }

    const huidigeStreak = sessies.find((s) => s.afgerond)?.streak_dag || 0;
    const totaalVragen = pogingen.length;
    const totaalGoed = pogingen.filter((p) => p.correct).length;
    const gemiddeld = totaalVragen > 0 ? Math.round((totaalGoed / totaalVragen) * 100) : 0;

    res.json({
      gebruiker,
      streak: huidigeStreak,
      totaal_vragen: totaalVragen,
      totaal_goed: totaalGoed,
      gemiddeld_percentage: gemiddeld,
      per_categorie: perCategorie,
      sessies_recent: sessies.slice(0, 10),
    });
  } catch (error) {
    logger.error('Theorie stats error:', error);
    res.status(500).json({ error: 'Kon stats niet ophalen' });
  }
});

// ============================================
// Email Inbox API (IJs email agent)
// ============================================

app.get('/api/inbox/threads', async (req, res) => {
  try {
    const { readItems } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 25));

    const filter: Record<string, unknown> = {};
    if (req.query.bedrijfId) filter.bedrijf = { _eq: parseInt(req.query.bedrijfId as string) };
    if (req.query.status) filter.status = { _eq: req.query.status as string };
    if (req.query.category) filter.ai_category = { _eq: req.query.category as string };
    if (req.query.q) {
      const q = req.query.q as string;
      filter._or = [
        { subject: { _icontains: q } },
        { from_email: { _icontains: q } },
        { from_name: { _icontains: q } },
        { ai_summary: { _icontains: q } },
      ];
    }

    const { aggregate } = await import('@directus/sdk');
    const countResult = await directus.request(aggregate('Email_Threads', { aggregate: { count: '*' }, query: { filter } as any }));
    const totalCount = parseInt((countResult as any)?.[0]?.count ?? '0', 10);

    const threads = await directus.request(readItems('Email_Threads', {
      fields: ['id', 'status', 'bedrijf', 'from_email', 'from_name', 'subject', 'ai_category', 'ai_priority', 'ai_summary', 'message_count', 'has_pending_draft', 'last_message_at', 'first_received_at', 'date_created'] as any,
      filter,
      sort: ['-last_message_at', '-date_created'],
      limit,
      offset: (page - 1) * limit,
    })) as any[];

    res.json({
      threads,
      meta: { total_count: totalCount, page, pages: Math.ceil(totalCount / limit) },
    });
  } catch (error) {
    logger.error('List inbox threads error:', error);
    res.status(500).json({ error: 'Failed to list inbox threads' });
  }
});

app.get('/api/inbox/threads/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id <= 0) return res.status(400).json({ error: 'Valid thread id required' });

  try {
    const { readItem, readItems } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');

    const [thread, messages] = await Promise.all([
      directus.request(readItem('Email_Threads', id)),
      directus.request(readItems('Email_Messages', {
        filter: { thread: { _eq: id } } as any,
        sort: ['date_created'] as any,
        limit: 100,
      })),
    ]);

    res.json({ thread, messages });
  } catch (error) {
    logger.error('Get inbox thread error:', error);
    res.status(500).json({ error: 'Failed to get inbox thread' });
  }
});

const draftUpdateSchema = z.object({
  subject: z.string().min(1).max(500).optional(),
  body_plain: z.string().min(1).max(60000).optional(),
  body_html: z.string().max(200000).optional(),
});

app.patch('/api/inbox/messages/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id <= 0) return res.status(400).json({ error: 'Valid message id required' });

  const parsed = draftUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  }

  try {
    const { updateItem, readItem } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');

    const existing = await directus.request(readItem('Email_Messages', id)) as any;
    if (!existing) return res.status(404).json({ error: 'Message not found' });
    if (existing.direction !== 'draft' || existing.status !== 'draft') {
      return res.status(400).json({ error: 'Alleen drafts kunnen bewerkt worden' });
    }

    const updated = await directus.request(updateItem('Email_Messages', id, {
      ...parsed.data,
      edited_by_human: true,
    }));

    res.json({ success: true, message: updated });
  } catch (error) {
    logger.error('Update draft error:', error);
    res.status(500).json({ error: 'Failed to update draft' });
  }
});

app.post('/api/inbox/messages/:id/send', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id <= 0) return res.status(400).json({ error: 'Valid message id required' });

  try {
    const { readItem, readItems } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');
    const { sendAndArchive } = await import('./email/inbox-poller');

    const draft = await directus.request(readItem('Email_Messages', id)) as any;
    if (!draft || draft.direction !== 'draft') {
      return res.status(400).json({ error: 'Geen geldig draft bericht' });
    }

    const thread = await directus.request(readItem('Email_Threads', draft.thread)) as any;
    if (!thread) return res.status(404).json({ error: 'Thread niet gevonden' });

    // laatste inkomende bericht voor In-Reply-To
    const lastInbound = await directus.request(readItems('Email_Messages', {
      filter: { thread: { _eq: draft.thread }, direction: { _eq: 'inbound' } } as any,
      sort: ['-date_created'] as any,
      limit: 1,
      fields: ['message_id'] as any,
    })) as any[];

    const toEmail = (draft.to_emails && draft.to_emails[0]) || thread.from_email;
    const sentByUserId = (req.headers['x-user-id'] as string) || undefined;

    const result = await sendAndArchive({
      threadId: draft.thread,
      toEmail,
      cc: draft.cc_emails || undefined,
      subject: draft.subject,
      bodyPlain: draft.body_plain,
      bodyHtml: draft.body_html,
      inReplyTo: lastInbound[0]?.message_id || undefined,
      references: lastInbound[0]?.message_id ? [lastInbound[0].message_id] : undefined,
      aiGenerated: !!draft.ai_generated,
      aiConfidence: draft.ai_confidence,
      aiReasoning: draft.ai_reasoning,
      editedByHuman: !!draft.edited_by_human,
      sentByUserId,
      draftMessageDbId: id,
    });

    if (!result.ok) return res.status(500).json({ error: result.error || 'Versturen mislukt' });

    const { updateItem } = await import('@directus/sdk');
    await directus.request(updateItem('Email_Threads', draft.thread, {
      status: 'sent',
      has_pending_draft: false,
    }));

    res.json({ success: true, messageDbId: result.messageDbId });
  } catch (error) {
    logger.error('Send draft error:', error);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

app.post('/api/inbox/messages/:id/discard', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id <= 0) return res.status(400).json({ error: 'Valid message id required' });

  try {
    const { updateItem, readItem, readItems } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');

    const draft = await directus.request(readItem('Email_Messages', id)) as any;
    if (!draft || draft.direction !== 'draft') return res.status(400).json({ error: 'Geen geldig draft' });

    await directus.request(updateItem('Email_Messages', id, { status: 'discarded' }));

    const remaining = await directus.request(readItems('Email_Messages', {
      filter: { thread: { _eq: draft.thread }, direction: { _eq: 'draft' }, status: { _eq: 'draft' } } as any,
      limit: 1,
      fields: ['id'] as any,
    })) as any[];

    if (remaining.length === 0) {
      await directus.request(updateItem('Email_Threads', draft.thread, { has_pending_draft: false }));
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Discard draft error:', error);
    res.status(500).json({ error: 'Failed to discard draft' });
  }
});

const threadStatusSchema = z.object({
  status: z.enum(['new', 'awaiting_review', 'auto_replied', 'sent', 'resolved', 'archived', 'spam']),
});

app.patch('/api/inbox/threads/:id/status', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id <= 0) return res.status(400).json({ error: 'Valid thread id required' });

  const parsed = threadStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  }

  try {
    const { updateItem } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');
    const thread = await directus.request(updateItem('Email_Threads', id, { status: parsed.data.status }));
    res.json({ success: true, thread });
  } catch (error) {
    logger.error('Update thread status error:', error);
    res.status(500).json({ error: 'Failed to update thread status' });
  }
});

app.post('/api/inbox/threads/:id/regenerate', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || id <= 0) return res.status(400).json({ error: 'Valid thread id required' });

  try {
    const { readItem, readItems, createItem, updateItem } = await import('@directus/sdk');
    const { directus } = await import('./config/directus');
    const { generateEmailReply } = await import('./ai-engine/email-agent');

    const thread = await directus.request(readItem('Email_Threads', id)) as any;
    if (!thread) return res.status(404).json({ error: 'Thread niet gevonden' });

    const lastInbound = await directus.request(readItems('Email_Messages', {
      filter: { thread: { _eq: id }, direction: { _eq: 'inbound' } } as any,
      sort: ['-date_created'] as any,
      limit: 1,
    })) as any[];

    if (!lastInbound[0]) return res.status(400).json({ error: 'Geen inkomend bericht in thread' });

    const m = lastInbound[0];
    const draft = await generateEmailReply(thread.bedrijf, {
      fromEmail: m.from_email,
      fromName: m.from_name,
      subject: m.subject,
      bodyPlain: m.body_plain || '',
      receivedAt: new Date(m.received_at || m.date_created),
    });

    // mark older drafts as discarded
    const oldDrafts = await directus.request(readItems('Email_Messages', {
      filter: { thread: { _eq: id }, direction: { _eq: 'draft' }, status: { _eq: 'draft' } } as any,
      fields: ['id'] as any,
    })) as any[];
    for (const d of oldDrafts) {
      await directus.request(updateItem('Email_Messages', d.id, { status: 'discarded' }));
    }

    const created = await directus.request(createItem('Email_Messages', {
      thread: id,
      direction: 'draft',
      status: 'draft',
      from_email: env.IJS_INBOX_USER,
      from_name: env.IJS_FROM_NAME,
      to_emails: [m.from_email],
      subject: draft.subject,
      body_plain: draft.bodyPlain,
      body_html: draft.bodyHtml,
      in_reply_to: m.message_id || null,
      ai_generated: true,
      ai_confidence: draft.confidence,
      ai_reasoning: draft.reasoning,
    })) as any;

    await directus.request(updateItem('Email_Threads', id, {
      status: 'awaiting_review',
      has_pending_draft: true,
      ai_category: draft.category,
      ai_priority: draft.priority,
      ai_summary: draft.summary,
    }));

    res.json({ success: true, draft: created });
  } catch (error) {
    logger.error('Regenerate draft error:', error);
    res.status(500).json({ error: 'Failed to regenerate draft' });
  }
});

app.post('/api/inbox/poll', async (_req, res) => {
  try {
    if (env.IJS_EMAIL_AGENT_ENABLED !== 'true') {
      return res.status(400).json({ error: 'Email agent is uitgeschakeld (IJS_EMAIL_AGENT_ENABLED=false)' });
    }
    const { emailInboxQueue } = await import('./scheduler/queues');
    const job = await emailInboxQueue.add(`manual-poll-${Date.now()}`, { source: 'manual' }, { priority: 1 });
    res.json({ message: 'Inbox poll queued', jobId: job.id });
  } catch (error) {
    logger.error('Manual inbox poll error:', error);
    res.status(500).json({ error: 'Failed to queue inbox poll' });
  }
});

app.get('/api/inbox/health', async (_req, res) => {
  try {
    const enabled = env.IJS_EMAIL_AGENT_ENABLED === 'true';
    if (!enabled) {
      return res.json({ enabled: false, imap: null, smtp: null, note: 'IJS_EMAIL_AGENT_ENABLED=false' });
    }
    const { getIjsImapConfig, testImapConnection } = await import('./email/imap-client');
    const { getIjsSmtpConfig, testSmtpConnection } = await import('./email/smtp-sender');

    const imapCfg = getIjsImapConfig();
    const smtpCfg = getIjsSmtpConfig();

    if (!imapCfg || !smtpCfg) {
      return res.json({ enabled: true, imap: { ok: false, error: 'IJS_INBOX_PASSWORD missing' }, smtp: null });
    }

    const [imap, smtp] = await Promise.all([
      testImapConnection(imapCfg),
      testSmtpConnection(smtpCfg),
    ]);

    res.json({ enabled: true, imap, smtp, user: env.IJS_INBOX_USER });
  } catch (error: any) {
    logger.error('Inbox health error:', error);
    res.status(500).json({ error: error?.message || 'Health check failed' });
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
