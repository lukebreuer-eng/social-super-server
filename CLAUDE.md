# CLAUDE.md - Social Super Server

## Project Overview

Social Super Server ("social-engine") is an automated social media management platform for IP Voice Group, IP Voice Shop & IJs uit de Polder. It generates AI-powered content, publishes to multiple platforms, tracks engagement, captures leads, and sends notifications.

## Tech Stack

- **Runtime:** Node.js 20+ / TypeScript 5.7
- **Framework:** Express.js 4.21
- **AI:** Anthropic Claude API (@anthropic-ai/sdk)
- **CMS/Database:** Directus (headless CMS via REST API)
- **Queue:** BullMQ + Redis (IORedis)
- **Object Storage:** MinIO (S3-compatible)
- **Image Generation:** Canvas + Sharp
- **Email:** Resend
- **Deployment:** Docker, Coolify

## Commands

```bash
npm run dev        # Development with hot-reload (tsx watch)
npm run build      # Compile TypeScript to dist/
npm start          # Run compiled production build
npm run lint       # ESLint (no config file exists yet)
npm run typecheck  # TypeScript type checking without emit
```

## Project Structure

```
src/
├── index.ts                    # Express app, API routes, startup/shutdown
├── config/
│   ├── env.ts                  # Zod-validated environment variables
│   ├── directus.ts             # Directus client, type definitions, DB helpers
│   └── redis.ts                # Redis client, cache helpers, rate limiting
├── ai-engine/
│   └── content-generator.ts    # Claude AI content generation with platform constraints
├── blog/
│   ├── blog-generator.ts       # AI blog writing with SEO, brand voice, keyword targeting
│   └── blog-analytics.ts       # WordPress view/comment sync + dashboard data
├── publishers/
│   ├── publisher.ts            # Publisher router (dispatches to platform publishers)
│   ├── meta-publisher.ts       # Facebook + Instagram (Graph API v21.0)
│   ├── linkedin-publisher.ts   # LinkedIn (UGC API v2)
│   ├── tiktok-publisher.ts     # TikTok (Content Posting API)
│   └── wordpress-publisher.ts  # WordPress REST API (blog posts, tags, Rank Math SEO)
├── scheduler/
│   ├── queues.ts               # 9 BullMQ queue definitions
│   ├── workers.ts              # 9 BullMQ workers (content, publish, sync, tokens, leads, blog, analytics)
│   └── cron-jobs.ts            # 7 cron jobs (publish, generate, engagement, tokens, reports, blog publish, blog analytics)
├── analytics/
│   ├── engagement-sync.ts      # Pull metrics from Meta/LinkedIn APIs
│   └── report-generator.ts     # Weekly/monthly report generation
├── oauth/
│   └── token-manager.ts        # OAuth token refresh + initial auth callbacks
├── leads/
│   └── lead-scorer.ts          # Lead capture webhook + weighted scoring
├── email/
│   └── notifications.ts        # Email templates (review, lead, digest) via Resend
├── visual-engine/
│   └── image-generator.ts      # Canvas-based image generation + MinIO upload
└── utils/
    └── logger.ts               # Winston logger (console + file rotation)
```

## Architecture

### Data Flow
1. Cron job triggers content generation daily at 06:00 UTC
2. Content generation worker calls Claude AI, creates post in Directus as `pending_review`
3. Human approves post in Directus UI
4. Publish scheduler cron (every 2 min) picks up approved+scheduled posts
5. Publish worker sends to platform APIs (Meta/LinkedIn/TikTok)
6. Engagement sync cron (every 30 min) pulls metrics back from platforms
7. Weekly report cron generates analytics summaries

### Directus Collections
Bedrijven, Social_Accounts, Posts, Leads, Content_Templates, Insights, Post_Log, AI_Knowledge_Base, AI_Suggestions, Campaigns, Competitors, Ad_Campaigns, Ad_Creatives

### Blog Flow
1. `POST /api/blog/generate` with keyword → AI writes SEO blog in brand voice
2. Blog saved in Directus as `pending_review` → email notification
3. Human reviews and approves in Directus
4. Blog publish cron (every 5 min) picks up approved blogs
5. Worker publishes to WordPress via REST API (with tags, Rank Math SEO meta)
6. Blog analytics cron (every 6h) syncs views/comments back from WordPress
7. Dashboard endpoint shows performance per bedrijf

### API Endpoints
- `GET  /health` — Liveness check (always 200)
- `GET  /api/queues` — Queue status for all 9 queues
- `POST /api/generate` — Manual content generation (requires `bedrijfId`, `platform`)
- `POST /api/blog/generate` — Manual blog generation (requires `bedrijfId`, `keyword`)
- `GET  /api/blog/dashboard/:bedrijfId` — Blog analytics dashboard
- `POST /api/leads` — Lead capture webhook
- `GET  /oauth/:platform/callback` — OAuth redirect handler (meta, linkedin, tiktok)

## Key Patterns

- **Dynamic imports** in workers to avoid circular dependencies (`await import(...)`)
- **All content in Dutch** — AI system prompts, email templates, and field names are Dutch
- **Directus as single source of truth** — all data reads/writes go through Directus REST API
- **BullMQ for all async work** — never call heavy operations synchronously from API routes
- **Rate limiting** via Redis counters (10 posts/hour per account, 10 generations/minute)
- **Graceful shutdown** — SIGTERM/SIGINT handlers close workers, cron jobs, and Redis

## Environment Variables

Required: `DIRECTUS_URL`, `DIRECTUS_TOKEN`, `REDIS_URL`, `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `ANTHROPIC_API_KEY`

Optional: `API_KEY` (enables auth on /api/* endpoints), `NOTIFICATION_EMAIL` (fallback email for notifications)

Optional (platform OAuth): `META_APP_ID`, `META_APP_SECRET`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`

See `.env.example` for full list.

## API Authentication

All `/api/*` endpoints require a `Bearer` token when `API_KEY` is set:
```
Authorization: Bearer <your-api-key>
```
Health endpoint (`/health`) and OAuth callbacks are unauthenticated.
When `API_KEY` is not set, auth is disabled (development mode).

## Known Issues

- **No tests** — no test framework or test files
- **Path aliases** (`@/*`) configured in tsconfig but no runtime resolver installed
