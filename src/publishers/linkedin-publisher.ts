import axios from 'axios';
import { Post, SocialAccount } from '../config/directus';
import { PublishResult } from './publisher';
import { logger } from '../utils/logger';

const LINKEDIN_API_URL = 'https://api.linkedin.com/v2';

// ============================================
// LinkedIn Publisher
// ============================================

export async function publishToLinkedIn(post: Post, account: SocialAccount): Promise<PublishResult> {
  const accessToken = account.access_token;
  const authorUrn = `urn:li:organization:${account.platform_page_id}`;

  try {
    const fullCaption = buildLinkedInCaption(post);

    // Build the share content
    const shareContent: Record<string, unknown> = {
      author: authorUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text: fullCaption,
          },
          shareMediaCategory: post.media ? 'IMAGE' : 'NONE',
          ...(post.media ? {
            media: [
              {
                status: 'READY',
                originalUrl: post.media,
                description: {
                  text: post.title,
                },
              },
            ],
          } : {}),
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    };

    // If there's a CTA link, add article content
    if (post.cta_link && !post.media) {
      shareContent.specificContent = {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: fullCaption },
          shareMediaCategory: 'ARTICLE',
          media: [
            {
              status: 'READY',
              originalUrl: post.cta_link,
              title: { text: post.cta_text || post.title },
            },
          ],
        },
      };
    }

    const response = await axios.post(
      `${LINKEDIN_API_URL}/ugcPosts`,
      shareContent,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0',
        },
      }
    );

    const postUrn = response.headers['x-restli-id'] || response.data.id;

    return {
      platform: 'linkedin',
      platformPostId: postUrn,
      platformPostUrl: `https://www.linkedin.com/feed/update/${postUrn}`,
      success: true,
    };
  } catch (error) {
    logger.error('LinkedIn publish error:', error);
    throw new Error(`LinkedIn publish failed: ${getLinkedInErrorMessage(error)}`);
  }
}

// ============================================
// Helpers
// ============================================

function buildLinkedInCaption(post: Post): string {
  let caption = post.caption;

  // LinkedIn: hashtags inline, max 5
  if (post.hashtags && post.hashtags.length > 0) {
    const topHashtags = post.hashtags.slice(0, 5);
    caption += '\n\n' + topHashtags.join(' ');
  }

  // Add CTA if present
  if (post.cta_text && post.cta_link) {
    caption += `\n\n${post.cta_text}: ${post.cta_link}`;
  }

  return caption;
}

function getLinkedInErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error) && error.response?.data) {
    return error.response.data.message || JSON.stringify(error.response.data);
  }
  return error instanceof Error ? error.message : String(error);
}
