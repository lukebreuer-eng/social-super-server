import axios from 'axios';
import { logger } from '../utils/logger';

// ============================================
// Types
// ============================================

export interface WordPressSite {
  url: string;         // e.g. https://ijsuitdepolder.nl
  username: string;    // WP username
  appPassword: string; // WP application password
}

export interface WordPressPublishInput {
  site: WordPressSite;
  title: string;
  slug: string;
  content: string;
  excerpt: string;
  status: 'draft' | 'publish';
  categories?: number[];
  tags?: string[];
  featuredImageId?: number;
  metaTitle?: string;
  metaDescription?: string;
  focusKeyword?: string;
}

export interface WordPressPublishResult {
  postId: number;
  postUrl: string;
  editUrl: string;
  success: boolean;
}

// ============================================
// WordPress REST API Publisher
// ============================================

export async function publishToWordPress(input: WordPressPublishInput): Promise<WordPressPublishResult> {
  const { site, title, slug, content, excerpt, status, categories, tags, featuredImageId, metaTitle, metaDescription, focusKeyword } = input;

  const apiUrl = `${site.url.replace(/\/$/, '')}/wp-json/wp/v2`;
  const auth = Buffer.from(`${site.username}:${site.appPassword}`).toString('base64');

  const headers = {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json',
  };

  try {
    // Resolve tag names to IDs (create if needed)
    let tagIds: number[] = [];
    if (tags && tags.length > 0) {
      tagIds = await resolveTagIds(apiUrl, headers, tags);
    }

    // Create the post
    const postData: Record<string, unknown> = {
      title,
      slug,
      content,
      excerpt,
      status,
    };

    if (categories && categories.length > 0) {
      postData.categories = categories;
    }
    if (tagIds.length > 0) {
      postData.tags = tagIds;
    }
    if (featuredImageId) {
      postData.featured_media = featuredImageId;
    }

    const response = await axios.post(`${apiUrl}/posts`, postData, { headers });

    const postId = response.data.id;
    const postUrl = response.data.link;
    const editUrl = `${site.url.replace(/\/$/, '')}/wp-admin/post.php?post=${postId}&action=edit`;

    // Update Rank Math SEO meta in a separate request (more reliable)
    if (metaTitle || metaDescription || focusKeyword) {
      try {
        await axios.post(`${apiUrl}/posts/${postId}`, {
          meta: {
            rank_math_title: metaTitle || '',
            rank_math_description: metaDescription || '',
            rank_math_focus_keyword: focusKeyword || '',
          },
        }, { headers });
        logger.info(`Rank Math SEO meta set for post ${postId}`);
      } catch (error) {
        logger.warn(`Failed to set Rank Math meta for post ${postId}:`, error);
      }
    }

    logger.info(`Blog published to WordPress: ${postUrl} (ID: ${postId})`);

    return {
      postId,
      postUrl,
      editUrl,
      success: true,
    };
  } catch (error) {
    logger.error('WordPress publish error:', error);
    throw new Error(`WordPress publish failed: ${getWPErrorMessage(error)}`);
  }
}

// ============================================
// Blog Analytics - fetch post views
// ============================================

export async function fetchWordPressPostStats(site: WordPressSite, postId: number): Promise<{
  views: number;
  comments: number;
}> {
  const apiUrl = `${site.url.replace(/\/$/, '')}/wp-json/wp/v2`;
  const auth = Buffer.from(`${site.username}:${site.appPassword}`).toString('base64');
  const headers = { 'Authorization': `Basic ${auth}` };

  try {
    // Get comment count from WP REST API
    const postResponse = await axios.get(`${apiUrl}/posts/${postId}`, { headers });
    const commentCount = postResponse.data.comment_count || 0;

    // Try to get views from popular plugins (Jetpack, WP Statistics, Post Views Counter)
    let views = 0;

    // Try Post Views Counter plugin
    try {
      const statsResponse = await axios.get(
        `${site.url.replace(/\/$/, '')}/wp-json/post-views-counter/v1/views/${postId}`,
        { headers }
      );
      views = statsResponse.data.views || 0;
    } catch {
      // Plugin not installed, try WordPress.com Stats (Jetpack)
      try {
        const jetpackResponse = await axios.get(
          `${apiUrl}/posts/${postId}?_fields=jetpack_stats`,
          { headers }
        );
        views = jetpackResponse.data.jetpack_stats?.views || 0;
      } catch {
        // No view tracking plugin available
        logger.debug(`No view stats available for post ${postId} on ${site.url}`);
      }
    }

    return { views, comments: commentCount };
  } catch (error) {
    logger.warn(`Failed to fetch stats for WP post ${postId}:`, error);
    return { views: 0, comments: 0 };
  }
}

// ============================================
// Media Library Search
// ============================================

export async function searchWordPressMedia(
  site: WordPressSite,
  searchTerms: string[]
): Promise<{ id: number; url: string } | null> {
  const apiUrl = `${site.url.replace(/\/$/, '')}/wp-json/wp/v2`;
  const auth = Buffer.from(`${site.username}:${site.appPassword}`).toString('base64');
  const headers = { 'Authorization': `Basic ${auth}` };

  // Collect all candidates from all search terms, then pick the best
  const candidates: Array<{ id: number; url: string; width: number; term: string }> = [];

  for (const term of searchTerms) {
    try {
      const response = await axios.get(`${apiUrl}/media`, {
        headers,
        params: {
          search: term,
          per_page: 5,
          media_type: 'image',
        },
      });

      for (const media of response.data) {
        // Skip tiny images (icons, thumbnails)
        const width = media.media_details?.width || 0;
        if (width < 400) continue;

        // Avoid duplicates
        if (!candidates.some(c => c.id === media.id)) {
          candidates.push({
            id: media.id,
            url: media.source_url,
            width,
            term,
          });
        }
      }
    } catch {
      // Search term didn't match, try next
    }
  }

  if (candidates.length === 0) {
    logger.info(`No matching media found in WP library for: ${searchTerms.join(', ')}`);
    return null;
  }

  // Pick the largest image (best quality for featured image)
  candidates.sort((a, b) => b.width - a.width);
  const best = candidates[0];

  logger.info(`Found WP media for "${best.term}": ${best.id} — ${best.url} (${best.width}px, ${candidates.length} candidates)`);
  return { id: best.id, url: best.url };
}

// ============================================
// Helpers
// ============================================

async function resolveTagIds(apiUrl: string, headers: Record<string, string>, tagNames: string[]): Promise<number[]> {
  const ids: number[] = [];

  for (const name of tagNames) {
    try {
      // Search for existing tag
      const searchResponse = await axios.get(`${apiUrl}/tags?search=${encodeURIComponent(name)}&per_page=1`, { headers });

      if (searchResponse.data.length > 0) {
        ids.push(searchResponse.data[0].id);
      } else {
        // Create new tag
        const createResponse = await axios.post(`${apiUrl}/tags`, { name }, { headers });
        ids.push(createResponse.data.id);
      }
    } catch (error) {
      logger.warn(`Failed to resolve tag "${name}":`, error);
    }
  }

  return ids;
}

function getWPErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error) && error.response?.data) {
    return error.response.data.message || JSON.stringify(error.response.data);
  }
  return error instanceof Error ? error.message : String(error);
}

logger.info('✅ WordPress Publisher initialized');
