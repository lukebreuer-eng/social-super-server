import axios from 'axios';
import { Post, SocialAccount } from '../config/directus';
import { PublishResult } from './publisher';
import { logger } from '../utils/logger';

const TIKTOK_API_URL = 'https://open.tiktokapis.com/v2';

// ============================================
// TikTok Publisher
// ============================================

export async function publishToTikTok(post: Post, account: SocialAccount): Promise<PublishResult> {
  const accessToken = account.access_token;

  try {
    const fullCaption = buildTikTokCaption(post);

    // TikTok Content Posting API - Photo post
    // Note: Video uploads require a different flow (upload + publish)
    const postData = {
      post_info: {
        title: fullCaption,
        privacy_level: 'PUBLIC_TO_EVERYONE',
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: 'PULL_FROM_URL',
        photo_cover_index: 0,
        ...(post.media ? { photo_images: [post.media] } : {}),
      },
    };

    const response = await axios.post(
      `${TIKTOK_API_URL}/post/publish/content/init/`,
      postData,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
      }
    );

    if (response.data.error?.code !== 'ok' && response.data.error?.code) {
      throw new Error(response.data.error.message || 'TikTok API error');
    }

    const publishId = response.data.data?.publish_id || '';

    // Poll for publish status
    const finalStatus = await pollTikTokStatus(publishId, accessToken);

    return {
      platform: 'tiktok',
      platformPostId: finalStatus.postId || publishId,
      platformPostUrl: finalStatus.postUrl || `https://tiktok.com/@${account.platform_user_id}`,
      success: true,
    };
  } catch (error) {
    logger.error('TikTok publish error:', error);
    throw new Error(`TikTok publish failed: ${getTikTokErrorMessage(error)}`);
  }
}

// ============================================
// Helpers
// ============================================

async function pollTikTokStatus(
  publishId: string,
  accessToken: string,
  maxAttempts = 15
): Promise<{ postId: string; postUrl: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));

    try {
      const response = await axios.post(
        `${TIKTOK_API_URL}/post/publish/status/fetch/`,
        { publish_id: publishId },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const status = response.data.data?.status;

      if (status === 'PUBLISH_COMPLETE') {
        return {
          postId: response.data.data?.publicaly_available_post_id?.[0] || publishId,
          postUrl: '',
        };
      }

      if (status === 'FAILED') {
        throw new Error(response.data.data?.fail_reason || 'TikTok publish failed');
      }
    } catch (error) {
      if (i === maxAttempts - 1) throw error;
    }
  }

  throw new Error('TikTok publish timed out');
}

function buildTikTokCaption(post: Post): string {
  let caption = post.caption;

  // TikTok prefers hashtags inline
  if (post.hashtags && post.hashtags.length > 0) {
    const topHashtags = post.hashtags.slice(0, 15);
    caption += ' ' + topHashtags.join(' ');
  }

  // TikTok max caption: 2200 chars
  if (caption.length > 2200) {
    caption = caption.substring(0, 2197) + '...';
  }

  return caption;
}

function getTikTokErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error) && error.response?.data?.error) {
    return error.response.data.error.message || JSON.stringify(error.response.data);
  }
  return error instanceof Error ? error.message : String(error);
}
