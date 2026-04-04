import axios from 'axios';
import { Post, SocialAccount } from '../config/directus';
import { PublishResult } from './publisher';
import { logger } from '../utils/logger';

const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';

// ============================================
// Meta Publisher (Facebook + Instagram)
// ============================================

export async function publishToMeta(post: Post, account: SocialAccount): Promise<PublishResult> {
  if (account.platform === 'instagram') {
    return publishToInstagram(post, account);
  }
  return publishToFacebook(post, account);
}

// ============================================
// Facebook Publishing
// ============================================

async function publishToFacebook(post: Post, account: SocialAccount): Promise<PublishResult> {
  const pageId = account.platform_page_id;
  const accessToken = account.access_token;

  try {
    // Build caption with hashtags
    const fullCaption = buildCaption(post);

    let response;

    if (post.media) {
      // Photo post
      response = await axios.post(`${META_GRAPH_URL}/${pageId}/photos`, {
        url: post.media, // URL to the image
        message: fullCaption,
        access_token: accessToken,
      });
    } else {
      // Text/link post
      const params: Record<string, string> = {
        message: fullCaption,
        access_token: accessToken,
      };

      if (post.cta_link) {
        params.link = post.cta_link;
      }

      response = await axios.post(`${META_GRAPH_URL}/${pageId}/feed`, params);
    }

    const postId = response.data.id || response.data.post_id;

    return {
      platform: 'facebook',
      platformPostId: postId,
      platformPostUrl: `https://facebook.com/${postId}`,
      success: true,
    };
  } catch (error) {
    logger.error('Facebook publish error:', error);
    throw new Error(`Facebook publish failed: ${getMetaErrorMessage(error)}`);
  }
}

// ============================================
// Instagram Publishing (Container-based)
// ============================================

async function publishToInstagram(post: Post, account: SocialAccount): Promise<PublishResult> {
  const igUserId = account.platform_user_id;
  const accessToken = account.access_token;

  try {
    const fullCaption = buildCaption(post);

    // Step 1: Create media container
    const containerParams: Record<string, string> = {
      caption: fullCaption,
      access_token: accessToken,
    };

    if (post.media) {
      containerParams.image_url = post.media;
    }

    const containerResponse = await axios.post(
      `${META_GRAPH_URL}/${igUserId}/media`,
      containerParams
    );

    const containerId = containerResponse.data.id;

    // Step 2: Wait for container to be ready (poll status)
    await waitForContainer(containerId, accessToken);

    // Step 3: Publish the container
    const publishResponse = await axios.post(
      `${META_GRAPH_URL}/${igUserId}/media_publish`,
      {
        creation_id: containerId,
        access_token: accessToken,
      }
    );

    const mediaId = publishResponse.data.id;

    // Step 4: Get permalink
    const permalinkResponse = await axios.get(
      `${META_GRAPH_URL}/${mediaId}?fields=permalink&access_token=${accessToken}`
    );

    return {
      platform: 'instagram',
      platformPostId: mediaId,
      platformPostUrl: permalinkResponse.data.permalink || `https://instagram.com/p/${mediaId}`,
      success: true,
    };
  } catch (error) {
    logger.error('Instagram publish error:', error);
    throw new Error(`Instagram publish failed: ${getMetaErrorMessage(error)}`);
  }
}

// ============================================
// Helpers
// ============================================

async function waitForContainer(containerId: string, accessToken: string, maxAttempts = 10): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await axios.get(
      `${META_GRAPH_URL}/${containerId}?fields=status_code&access_token=${accessToken}`
    );

    if (response.data.status_code === 'FINISHED') {
      return;
    }

    if (response.data.status_code === 'ERROR') {
      throw new Error('Instagram container creation failed');
    }

    // Wait 3 seconds between checks
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  throw new Error('Instagram container timed out');
}

function buildCaption(post: Post): string {
  let caption = post.caption;

  if (post.hashtags && post.hashtags.length > 0) {
    caption += '\n\n' + post.hashtags.join(' ');
  }

  return caption;
}

function getMetaErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error) && error.response?.data?.error) {
    return error.response.data.error.message || 'Unknown Meta API error';
  }
  return error instanceof Error ? error.message : String(error);
}
