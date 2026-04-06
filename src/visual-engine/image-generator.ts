import sharp from 'sharp';
import { createCanvas, CanvasRenderingContext2D } from 'canvas';
import { Client as MinioClient } from 'minio';
import axios from 'axios';
import FormData from 'form-data';
import { env } from '../config/env';
import { Bedrijf } from '../config/directus';
import { logger } from '../utils/logger';
import crypto from 'crypto';

// ============================================
// MinIO Client
// ============================================

const minio = new MinioClient({
  endPoint: env.MINIO_ENDPOINT,
  port: parseInt(env.MINIO_PORT),
  useSSL: env.MINIO_USE_SSL === 'true',
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
});

const BUCKET = env.MINIO_BUCKET;

// ============================================
// Types
// ============================================

interface ImageOptions {
  width: number;
  height: number;
  backgroundColor: string;
  textColor: string;
  accentColor: string;
  title: string;
  subtitle?: string;
  logoUrl?: string;
  overlayText?: string;
  template: 'quote' | 'announcement' | 'tip' | 'promo' | 'stats';
}

interface GeneratedImage {
  url: string;
  key: string;
  width: number;
  height: number;
  directusFileId: string | null;
}

// Platform dimensions
const PLATFORM_SIZES: Record<string, { width: number; height: number }> = {
  'instagram-square': { width: 1080, height: 1080 },
  'instagram-portrait': { width: 1080, height: 1350 },
  'instagram-story': { width: 1080, height: 1920 },
  'facebook-post': { width: 1200, height: 630 },
  'facebook-story': { width: 1080, height: 1920 },
  'linkedin-post': { width: 1200, height: 627 },
  'linkedin-article': { width: 1200, height: 644 },
  'tiktok-video': { width: 1080, height: 1920 },
};

// ============================================
// Image Generation
// ============================================

export async function generateImage(
  bedrijf: Bedrijf,
  options: Partial<ImageOptions> & { title: string },
  platformFormat: string = 'instagram-square'
): Promise<GeneratedImage> {
  const size = PLATFORM_SIZES[platformFormat] || PLATFORM_SIZES['instagram-square'];

  // Get brand colors
  const brandColors = bedrijf.brand_colors || {};
  const primaryColor = brandColors.primary || '#1a1a2e';
  const secondaryColor = brandColors.secondary || '#16213e';
  const textColor = brandColors.text || '#ffffff';

  const fullOptions: ImageOptions = {
    width: size.width,
    height: size.height,
    backgroundColor: primaryColor,
    textColor: textColor,
    accentColor: secondaryColor,
    template: options.template || 'announcement',
    title: options.title,
    subtitle: options.subtitle,
    logoUrl: options.logoUrl || undefined,
    overlayText: options.overlayText,
  };

  // Generate with Canvas
  const buffer = await renderTemplate(fullOptions);

  // Optimize with Sharp
  const optimized = await sharp(buffer)
    .png({ quality: 90, compressionLevel: 6 })
    .toBuffer();

  // Upload to MinIO
  const key = `posts/${bedrijf.id}/${crypto.randomUUID()}.png`;

  await ensureBucket();
  await minio.putObject(BUCKET, key, optimized, optimized.length, {
    'Content-Type': 'image/png',
  });

  const url = `${env.MINIO_USE_SSL === 'true' ? 'https' : 'http'}://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}/${BUCKET}/${key}`;

  logger.info(`Image generated and uploaded: ${key} (${optimized.length} bytes)`);

  // Also upload to Directus Files so it can be used as media relation
  let directusFileId: string | null = null;
  try {
    directusFileId = await uploadToDirectusFiles(optimized, `${bedrijf.id}-${crypto.randomUUID()}.png`);
    logger.info(`Image uploaded to Directus Files: ${directusFileId}`);
  } catch (error) {
    logger.warn('Failed to upload image to Directus Files:', error);
  }

  return {
    url,
    key,
    width: fullOptions.width,
    height: fullOptions.height,
    directusFileId,
  };
}

// ============================================
// Template Renderer
// ============================================

async function renderTemplate(options: ImageOptions): Promise<Buffer> {
  const { width, height } = options;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  switch (options.template) {
    case 'quote':
      renderQuoteTemplate(ctx, options);
      break;
    case 'tip':
      renderTipTemplate(ctx, options);
      break;
    case 'promo':
      renderPromoTemplate(ctx, options);
      break;
    case 'stats':
      renderStatsTemplate(ctx, options);
      break;
    case 'announcement':
    default:
      renderAnnouncementTemplate(ctx, options);
      break;
  }

  return canvas.toBuffer('image/png');
}

// ============================================
// Template: Quote
// ============================================

function renderQuoteTemplate(ctx: CanvasRenderingContext2D, opts: ImageOptions): void {
  const { width, height, backgroundColor, textColor, accentColor } = opts;

  // Background gradient
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, backgroundColor);
  gradient.addColorStop(1, adjustColor(backgroundColor, -30));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Quote marks
  ctx.fillStyle = accentColor;
  ctx.font = `bold ${Math.floor(width * 0.15)}px sans-serif`;
  ctx.fillText('"', width * 0.08, height * 0.25);

  // Quote text
  ctx.fillStyle = textColor;
  ctx.font = `bold ${Math.floor(width * 0.045)}px sans-serif`;
  wrapText(ctx, opts.title, width * 0.12, height * 0.3, width * 0.76, Math.floor(width * 0.06));

  // Subtitle (author/source)
  if (opts.subtitle) {
    ctx.fillStyle = adjustColor(textColor, -40);
    ctx.font = `${Math.floor(width * 0.03)}px sans-serif`;
    ctx.fillText(`— ${opts.subtitle}`, width * 0.12, height * 0.78);
  }

  // Bottom accent bar
  ctx.fillStyle = accentColor;
  ctx.fillRect(0, height - 8, width, 8);
}

// ============================================
// Template: Announcement
// ============================================

function renderAnnouncementTemplate(ctx: CanvasRenderingContext2D, opts: ImageOptions): void {
  const { width, height, backgroundColor, textColor, accentColor } = opts;

  // Solid background
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, width, height);

  // Accent circle decoration
  ctx.beginPath();
  ctx.arc(width * 0.85, height * 0.15, width * 0.2, 0, Math.PI * 2);
  ctx.fillStyle = accentColor + '33'; // 20% opacity
  ctx.fill();

  // Title
  ctx.fillStyle = textColor;
  ctx.font = `bold ${Math.floor(width * 0.06)}px sans-serif`;
  wrapText(ctx, opts.title, width * 0.08, height * 0.35, width * 0.84, Math.floor(width * 0.08));

  // Subtitle
  if (opts.subtitle) {
    ctx.fillStyle = adjustColor(textColor, -30);
    ctx.font = `${Math.floor(width * 0.035)}px sans-serif`;
    wrapText(ctx, opts.subtitle, width * 0.08, height * 0.65, width * 0.84, Math.floor(width * 0.05));
  }

  // Bottom bar
  ctx.fillStyle = accentColor;
  ctx.fillRect(width * 0.08, height - 60, width * 0.3, 4);
}

// ============================================
// Template: Tip
// ============================================

function renderTipTemplate(ctx: CanvasRenderingContext2D, opts: ImageOptions): void {
  const { width, height, backgroundColor, textColor, accentColor } = opts;

  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, width, height);

  // "TIP" badge
  const badgeWidth = width * 0.25;
  const badgeHeight = height * 0.06;
  ctx.fillStyle = accentColor;
  roundRect(ctx, width * 0.08, height * 0.12, badgeWidth, badgeHeight, 8);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.floor(width * 0.03)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('TIP', width * 0.08 + badgeWidth / 2, height * 0.12 + badgeHeight * 0.7);
  ctx.textAlign = 'left';

  // Tip text
  ctx.fillStyle = textColor;
  ctx.font = `bold ${Math.floor(width * 0.05)}px sans-serif`;
  wrapText(ctx, opts.title, width * 0.08, height * 0.3, width * 0.84, Math.floor(width * 0.065));

  if (opts.subtitle) {
    ctx.fillStyle = adjustColor(textColor, -30);
    ctx.font = `${Math.floor(width * 0.032)}px sans-serif`;
    wrapText(ctx, opts.subtitle, width * 0.08, height * 0.7, width * 0.84, Math.floor(width * 0.045));
  }
}

// ============================================
// Template: Promo
// ============================================

function renderPromoTemplate(ctx: CanvasRenderingContext2D, opts: ImageOptions): void {
  const { width, height, backgroundColor, textColor, accentColor } = opts;

  // Gradient background
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, accentColor);
  gradient.addColorStop(1, backgroundColor);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Large title
  ctx.fillStyle = textColor;
  ctx.font = `bold ${Math.floor(width * 0.07)}px sans-serif`;
  wrapText(ctx, opts.title, width * 0.1, height * 0.3, width * 0.8, Math.floor(width * 0.09));

  // CTA button
  if (opts.subtitle) {
    const btnWidth = width * 0.5;
    const btnHeight = height * 0.07;
    const btnX = (width - btnWidth) / 2;
    const btnY = height * 0.75;

    ctx.fillStyle = '#ffffff';
    roundRect(ctx, btnX, btnY, btnWidth, btnHeight, btnHeight / 2);
    ctx.fill();

    ctx.fillStyle = backgroundColor;
    ctx.font = `bold ${Math.floor(width * 0.03)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(opts.subtitle, width / 2, btnY + btnHeight * 0.65);
    ctx.textAlign = 'left';
  }
}

// ============================================
// Template: Stats
// ============================================

function renderStatsTemplate(ctx: CanvasRenderingContext2D, opts: ImageOptions): void {
  const { width, height, backgroundColor, textColor, accentColor } = opts;

  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, width, height);

  // Big number/stat
  ctx.fillStyle = accentColor;
  ctx.font = `bold ${Math.floor(width * 0.15)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(opts.title, width / 2, height * 0.45);

  // Description
  if (opts.subtitle) {
    ctx.fillStyle = textColor;
    ctx.font = `${Math.floor(width * 0.04)}px sans-serif`;
    ctx.fillText(opts.subtitle, width / 2, height * 0.6);
  }
  ctx.textAlign = 'left';

  // Decorative lines
  ctx.strokeStyle = accentColor + '44';
  ctx.lineWidth = 2;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.moveTo(0, height * (0.1 + i * 0.2));
    ctx.lineTo(width, height * (0.1 + i * 0.2));
    ctx.stroke();
  }
}

// ============================================
// Utility Functions
// ============================================

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number
): void {
  const words = text.split(' ');
  let line = '';
  let currentY = y;

  for (const word of words) {
    const testLine = line + word + ' ';
    const metrics = ctx.measureText(testLine);

    if (metrics.width > maxWidth && line !== '') {
      ctx.fillText(line.trim(), x, currentY);
      line = word + ' ';
      currentY += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line.trim(), x, currentY);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function adjustColor(hex: string, amount: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + amount));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00FF) + amount));
  const b = Math.min(255, Math.max(0, (num & 0x0000FF) + amount));
  return `#${(r << 16 | g << 8 | b).toString(16).padStart(6, '0')}`;
}

async function ensureBucket(): Promise<void> {
  const exists = await minio.bucketExists(BUCKET);
  if (!exists) {
    await minio.makeBucket(BUCKET, 'us-east-1');
    logger.info(`Created MinIO bucket: ${BUCKET}`);
  }
}

async function uploadToDirectusFiles(imageBuffer: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append('file', imageBuffer, {
    filename,
    contentType: 'image/png',
  });

  const response = await axios.post(
    `${env.DIRECTUS_URL}/files`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${env.DIRECTUS_TOKEN}`,
      },
    }
  );

  return response.data.data.id;
}

logger.info('✅ Visual Engine initialized');
