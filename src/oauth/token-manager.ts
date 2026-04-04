import axios from 'axios';
import { directus, SocialAccount } from '../config/directus';
import { readItems, updateItem } from '@directus/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// ============================================
// OAuth Token Manager
// ============================================

export async function refreshToken(accountId: number, platform: string): Promise<void> {
  const accounts = await directus.request(
    readItems('Social_Accounts', { filter: { id: { _eq: accountId } }, limit: 1 })
  ) as SocialAccount[];

  if (!accounts.length) throw new Error(`Account ${accountId} not found`);
  const account = accounts[0];

  let newTokens: { access_token: string; refresh_token?: string; expires_in: number };

  switch (platform) {
    case 'facebook':
    case 'instagram':
      newTokens = await refreshMetaToken(account);
      break;
    case 'linkedin':
      newTokens = await refreshLinkedInToken(account);
      break;
    case 'tiktok':
      newTokens = await refreshTikTokToken(account);
      break;
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }

  // Calculate new expiry
  const expiresAt = new Date();
  expiresAt.setSeconds(expiresAt.getSeconds() + newTokens.expires_in);

  // Update in Directus
  await directus.request(
    updateItem('Social_Accounts', accountId, {
      access_token: newTokens.access_token,
      ...(newTokens.refresh_token ? { refresh_token: newTokens.refresh_token } : {}),
      token_expires: expiresAt.toISOString(),
      last_synced: new Date().toISOString(),
    })
  );

  logger.info(`Token refreshed for ${account.title} (${platform}), expires: ${expiresAt.toISOString()}`);
}

// ============================================
// Meta Token Refresh
// ============================================

async function refreshMetaToken(account: SocialAccount): Promise<{
  access_token: string;
  expires_in: number;
}> {
  // Meta long-lived tokens last 60 days and can be exchanged before expiry
  const response = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: env.META_APP_ID,
      client_secret: env.META_APP_SECRET,
      fb_exchange_token: account.access_token,
    },
  });

  return {
    access_token: response.data.access_token,
    expires_in: response.data.expires_in || 5184000, // Default 60 days
  };
}

// ============================================
// LinkedIn Token Refresh
// ============================================

async function refreshLinkedInToken(account: SocialAccount): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const response = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', null, {
    params: {
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token,
      client_id: env.LINKEDIN_CLIENT_ID,
      client_secret: env.LINKEDIN_CLIENT_SECRET,
    },
  });

  return {
    access_token: response.data.access_token,
    refresh_token: response.data.refresh_token || account.refresh_token,
    expires_in: response.data.expires_in || 5184000,
  };
}

// ============================================
// TikTok Token Refresh
// ============================================

async function refreshTikTokToken(account: SocialAccount): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const response = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', {
    client_key: env.TIKTOK_CLIENT_KEY,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: account.refresh_token,
  });

  return {
    access_token: response.data.access_token,
    refresh_token: response.data.refresh_token || account.refresh_token,
    expires_in: response.data.expires_in || 86400,
  };
}

// ============================================
// OAuth Callback Handler (for initial auth)
// ============================================

export async function handleOAuthCallback(
  platform: string,
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; userId: string }> {
  switch (platform) {
    case 'meta': {
      const response = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
        params: {
          client_id: env.META_APP_ID,
          client_secret: env.META_APP_SECRET,
          redirect_uri: redirectUri,
          code,
        },
      });

      // Exchange for long-lived token
      const longLivedResponse = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: env.META_APP_ID,
          client_secret: env.META_APP_SECRET,
          fb_exchange_token: response.data.access_token,
        },
      });

      // Get user ID
      const meResponse = await axios.get(`https://graph.facebook.com/v21.0/me?access_token=${longLivedResponse.data.access_token}`);

      return {
        accessToken: longLivedResponse.data.access_token,
        refreshToken: '',
        expiresIn: longLivedResponse.data.expires_in || 5184000,
        userId: meResponse.data.id,
      };
    }

    case 'linkedin': {
      const response = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', null, {
        params: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: env.LINKEDIN_CLIENT_ID,
          client_secret: env.LINKEDIN_CLIENT_SECRET,
        },
      });

      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token || '',
        expiresIn: response.data.expires_in || 5184000,
        userId: '',
      };
    }

    case 'tiktok': {
      const response = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', {
        client_key: env.TIKTOK_CLIENT_KEY,
        client_secret: env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      });

      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token || '',
        expiresIn: response.data.expires_in || 86400,
        userId: response.data.open_id || '',
      };
    }

    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

logger.info('✅ OAuth Token Manager initialized');
