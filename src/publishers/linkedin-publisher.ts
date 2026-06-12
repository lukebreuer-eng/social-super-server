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
  // Persoonlijke OAuth: gebruik person URN (sub uit OpenID). Voor company page
  // posts (Community Management API approval vereist) zou je organization URN
  // gebruiken — daar wisselen we t.z.t. naar als platform_page_id ingevuld is.
  const authorUrn = account.platform_page_id
    ? `urn:li:organization:${account.platform_page_id}`
    : `urn:li:person:${account.platform_user_id}`;

  try {
    const fullCaption = buildLinkedInCaption(post);

    // Upload media als die er is en bouw shareContent
    let mediaAsset: string | null = null;
    if (post.media) {
      try {
        mediaAsset = await uploadImageToLinkedIn(accessToken, post.media, authorUrn, post.title);
      } catch (e) {
        logger.warn('LinkedIn image upload mislukt, post zonder image:', e);
      }
    }

    const shareContent: Record<string, unknown> = {
      author: authorUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: fullCaption },
          shareMediaCategory: mediaAsset ? 'IMAGE' : (post.cta_link ? 'ARTICLE' : 'NONE'),
          ...(mediaAsset ? {
            media: [{
              status: 'READY',
              media: mediaAsset,
              description: { text: post.title || '' },
              title: { text: post.title || '' },
            }],
          } : (post.cta_link ? {
            media: [{
              status: 'READY',
              originalUrl: post.cta_link,
              title: { text: post.cta_text || post.title || '' },
            }],
          } : {})),
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    };

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

/**
 * Upload een afbeelding naar LinkedIn (3-stappen flow):
 * 1. Register upload met /assets?action=registerUpload — krijgt uploadUrl en asset URN
 * 2. PUT image binary naar uploadUrl
 * 3. Asset URN gebruiken in ugcPost media field
 */
async function uploadImageToLinkedIn(
  accessToken: string,
  mediaSource: string,
  authorUrn: string,
  alt: string,
): Promise<string> {
  // Stap 1: registreer upload
  const registerResp = await axios.post(
    `${LINKEDIN_API_URL}/assets?action=registerUpload`,
    {
      registerUploadRequest: {
        recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
        owner: authorUrn,
        serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }],
      },
    },
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
    },
  );

  const uploadUrl = registerResp.data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
  const asset = registerResp.data.value.asset;

  // Stap 2: download image en upload naar LinkedIn
  let imageBuffer: Buffer;
  if (/^https?:\/\//.test(mediaSource)) {
    const dl = await axios.get(mediaSource, { responseType: 'arraybuffer' });
    imageBuffer = Buffer.from(dl.data);
  } else {
    // Aanname: het is een Directus file ID
    const { env } = await import('../config/env');
    const dl = await axios.get(`${env.DIRECTUS_URL}/assets/${mediaSource}`, {
      responseType: 'arraybuffer',
      headers: { Authorization: `Bearer ${env.DIRECTUS_TOKEN}` },
    });
    imageBuffer = Buffer.from(dl.data);
  }

  await axios.put(uploadUrl, imageBuffer, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });

  logger.info(`LinkedIn image uploaded: ${asset} (${alt})`);
  return asset;
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
