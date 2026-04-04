import { createDirectus, rest, staticToken, readItems, createItem, updateItem, deleteItem } from '@directus/sdk';
import { env } from './env';
import { logger } from '../utils/logger';

// Type definitions matching our Directus schema
export interface Bedrijf {
  id: number;
  status: string;
  title: string;
  description: string;
  branche: string;
  website: string;
  logo: string | null;
  brand_colors: Record<string, string>;
  tone_of_voice: string;
  target_audience: string;
  unique_selling_points: string[];
  competitors: string;
  content_pillars: string[];
  posting_goals: Record<string, { per_week: number; type: string[] }>;
}

export interface SocialAccount {
  id: number;
  status: string;
  title: string;
  platform: string;
  url: string;
  bedrijf: number;
  access_token: string;
  refresh_token: string;
  token_expires: string;
  platform_user_id: string;
  platform_page_id: string;
  last_synced: string;
  is_connected: boolean;
  follower_count: number;
  posting_enabled: boolean;
}

export interface Post {
  id: number;
  user_created: string;
  date_created: string;
  title: string;
  caption: string;
  media: string | null;
  bedrijf: number;
  post_type: string;
  hashtags: string[];
  cta_link: string;
  cta_text: string;
  ai_generated: boolean;
  ai_prompt_used: string;
  ai_confidence_score: number;
  approval_status: string;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  revision_notes: string | null;
  scheduled_at: string | null;
  published_at: string | null;
  publish_priority: number;
  platform_post_id: string | null;
  platform_post_url: string | null;
  engagement_likes: number;
  engagement_comments: number;
  engagement_shares: number;
  engagement_saves: number;
  engagement_clicks: number;
  engagement_reach: number;
  engagement_impressions: number;
  engagement_score: number;
  error_message: string | null;
  retry_count: number;
  last_retry_at: string | null;
  campaign: number | null;
  social_accounts: number[];
}

export interface Lead {
  id: number;
  status: string;
  naam: string;
  email: string;
  telefoon: string;
  bedrijf_naam: string;
  bedrijf: number;
  bron: string;
  bron_post: number | null;
  bron_url: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  lead_score: number;
  lead_temperature: string;
  notities: string;
  assigned_to: string | null;
  campaign: number | null;
}

export interface ContentTemplate {
  id: number;
  status: string;
  title: string;
  bedrijf: number;
  platform: string;
  post_type: string;
  prompt_template: string;
  caption_template: string;
  hashtag_set: string[];
  visual_style: string;
  performance_score: number;
  times_used: number;
}

// Schema definition for Directus SDK
interface Schema {
  Bedrijven: Bedrijf[];
  Social_Accounts: SocialAccount[];
  Posts: Post[];
  Leads: Lead[];
  Content_Templates: ContentTemplate[];
  Insights: Record<string, unknown>[];
  Post_Log: Record<string, unknown>[];
  AI_Knowledge_Base: Record<string, unknown>[];
  AI_Suggestions: Record<string, unknown>[];
  Campaigns: Record<string, unknown>[];
  Competitors: Record<string, unknown>[];
  Ad_Campaigns: Record<string, unknown>[];
  Ad_Creatives: Record<string, unknown>[];
}

// Initialize Directus client
export const directus = createDirectus<Schema>(env.DIRECTUS_URL)
  .with(staticToken(env.DIRECTUS_TOKEN))
  .with(rest());

// Helper functions
export const db = {
  // Bedrijven
  async getBedrijven(): Promise<Bedrijf[]> {
    return directus.request(readItems('Bedrijven', { filter: { status: { _eq: 'published' } } }));
  },

  async getBedrijf(id: number): Promise<Bedrijf> {
    const items = await directus.request(readItems('Bedrijven', { filter: { id: { _eq: id } }, limit: 1 }));
    return items[0];
  },

  // Social Accounts
  async getActiveAccounts(bedrijfId?: number): Promise<SocialAccount[]> {
    const filter: Record<string, unknown> = { is_connected: { _eq: true }, posting_enabled: { _eq: true } };
    if (bedrijfId) filter.bedrijf = { _eq: bedrijfId };
    return directus.request(readItems('Social_Accounts', { filter }));
  },

  // Posts
  async getScheduledPosts(): Promise<Post[]> {
    return directus.request(readItems('Posts', {
      filter: {
        approval_status: { _eq: 'approved' },
        scheduled_at: { _lte: new Date().toISOString() },
        published_at: { _null: true },
      },
      sort: ['publish_priority', 'scheduled_at'],
    }));
  },

  async getPendingReviewPosts(): Promise<Post[]> {
    return directus.request(readItems('Posts', {
      filter: { approval_status: { _eq: 'pending_review' } },
      sort: ['-date_created'],
    }));
  },

  async createPost(data: Partial<Post>): Promise<Post> {
    return directus.request(createItem('Posts', data));
  },

  async updatePost(id: number, data: Partial<Post>): Promise<Post> {
    return directus.request(updateItem('Posts', id, data));
  },

  // Leads
  async createLead(data: Partial<Lead>): Promise<Lead> {
    return directus.request(createItem('Leads', data));
  },

  // Post Log
  async logAction(postId: number, action: string, details: string, success: boolean): Promise<void> {
    await directus.request(createItem('Post_Log', {
      post: postId,
      action,
      details,
      success,
    }));
  },

  // Content Templates
  async getTemplates(bedrijfId: number, platform?: string): Promise<ContentTemplate[]> {
    const filter: Record<string, unknown> = { bedrijf: { _eq: bedrijfId }, status: { _eq: 'active' } };
    if (platform) filter.platform = { _in: [platform, 'all'] };
    return directus.request(readItems('Content_Templates', { filter }));
  },
};

logger.info('✅ Directus client initialized for ' + env.DIRECTUS_URL);
