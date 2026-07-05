import * as cron from 'cron';
import { db } from '../config/directus';
import { logger } from '../utils/logger';
import {
  contentGenerationQueue,
  postPublishQueue,
  engagementSyncQueue,
  tokenRefreshQueue,
  analyticsQueue,
  blogPublishQueue,
  blogAnalyticsQueue,
  blogGenerationQueue,
  seoSyncQueue,
  suggestionsQueue,
  emailInboxQueue,
} from './queues';
import { env } from '../config/env';

const { CronJob } = cron;

// ============================================
// Cron Job Definitions
// ============================================

// Check for posts ready to publish - every 2 minutes
const publishScheduler = new CronJob('*/2 * * * *', async () => {
  try {
    const posts = await db.getScheduledPosts();
    if (posts.length === 0) return;

    logger.info(`Found ${posts.length} posts ready to publish`);

    for (const post of posts) {
      await postPublishQueue.add(
        `publish-${post.id}`,
        { postId: post.id },
        { priority: post.publish_priority }
      );
    }
  } catch (error) {
    logger.error('Publish scheduler error:', error);
  }
});

// Generate content for all bedrijven - every day at 06:00
const contentScheduler = new CronJob('0 6 * * *', async () => {
  try {
    const bedrijven = await db.getBedrijven();
    logger.info(`Generating content for ${bedrijven.length} bedrijven`);

    for (const bedrijf of bedrijven) {
      const accounts = await db.getActiveAccounts(bedrijf.id);
      const platforms = [...new Set(accounts.map(a => a.platform))];

      for (const platform of platforms) {
        await contentGenerationQueue.add(
          `generate-${bedrijf.id}-${platform}`,
          {
            bedrijfId: bedrijf.id,
            platform,
            postType: 'regular',
          },
          { priority: 5 }
        );
      }
    }
  } catch (error) {
    logger.error('Content scheduler error:', error);
  }
});

// Sync engagement metrics - every 30 minutes
const engagementScheduler = new CronJob('*/30 * * * *', async () => {
  try {
    const accounts = await db.getActiveAccounts();
    logger.info(`Syncing engagement for ${accounts.length} accounts`);

    for (const account of accounts) {
      await engagementSyncQueue.add(
        `sync-${account.id}`,
        { accountId: account.id, platform: account.platform }
      );
    }
  } catch (error) {
    logger.error('Engagement sync scheduler error:', error);
  }
});

// Refresh OAuth tokens - every 6 hours
const tokenScheduler = new CronJob('0 */6 * * *', async () => {
  try {
    const accounts = await db.getActiveAccounts();

    // Alleen OAuth-platforms hebben een refresh-token. WordPress werkt met een
    // app-wachtwoord (geen refresh), dus die niet in de queue gooien.
    const OAUTH_PLATFORMS = new Set(['facebook', 'instagram', 'linkedin', 'tiktok', 'meta']);

    for (const account of accounts) {
      if (!OAUTH_PLATFORMS.has(String(account.platform || '').toLowerCase())) continue;
      if (!account.token_expires) continue;
      // Check if token expires within 24 hours
      const expiresAt = new Date(account.token_expires);
      const hoursUntilExpiry = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);

      if (hoursUntilExpiry < 24) {
        logger.info(`Token for ${account.title} expires in ${hoursUntilExpiry.toFixed(1)}h, refreshing...`);
        await tokenRefreshQueue.add(
          `refresh-${account.id}`,
          { accountId: account.id, platform: account.platform }
        );
      }
    }
  } catch (error) {
    logger.error('Token refresh scheduler error:', error);
  }
});

// Weekly analytics report - every Monday at 08:00
const weeklyReportScheduler = new CronJob('0 8 * * 1', async () => {
  try {
    const bedrijven = await db.getBedrijven();

    for (const bedrijf of bedrijven) {
      await analyticsQueue.add(
        `weekly-report-${bedrijf.id}`,
        { bedrijfId: bedrijf.id, reportType: 'weekly' }
      );
    }
  } catch (error) {
    logger.error('Weekly report scheduler error:', error);
  }
});

// Auto-generate blogs - every Monday and Thursday at 07:00
const blogAutoGenerator = new CronJob('0 7 * * 1,4', async () => {
  try {
    const { directus } = await import('../config/directus');
    const { readItems } = await import('@directus/sdk');

    const bedrijven = await db.getBedrijven();
    logger.info(`Auto-generating blogs for ${bedrijven.length} bedrijven`);

    // Blog topics per bedrijf, based on cold lead plan and competitor analysis
    const blogTopics: Record<string, Array<{ keyword: string; topic: string }>> = {
      'IP Voice Group': [
        { keyword: 'overstappen cloud telefonie', topic: 'Overstappen naar cloud telefonie: het complete stappenplan voor MKB' },
        { keyword: '3CX vs Microsoft Teams', topic: '3CX vs Microsoft Teams bellen: eerlijke vergelijking' },
        { keyword: 'Mitel CX AI contactcenter', topic: 'Mitel CX met Talkative AI: het contactcenter dat zelf meedenkt' },
        { keyword: 'contact center software zorg', topic: 'Contact center software voor de zorg: waar let je op?' },
        { keyword: 'ISO 27001 telefonie', topic: 'ISO 27001 en je communicatie: wat moet je regelen?' },
        { keyword: 'kosten zakelijke telefonie', topic: 'Wat kost zakelijke telefonie per medewerker per maand?' },
        { keyword: 'hybride werken telefonie', topic: 'Hybride werken: waarom je PBX je tegenhoudt' },
        { keyword: 'Teams bellen kwaliteit', topic: 'Teams bellen: waarom de kwaliteit tegenvalt en hoe je het fixt' },
        { keyword: 'Intermedia Elevate UCaaS', topic: 'Intermedia Elevate: de nieuwe all-in-one voor zakelijke communicatie' },
        { keyword: 'zakelijke telefonie trends 2026', topic: 'Zakelijke telefonie trends: wat verandert er in 2026?' },
      ],
      'IJs uit de Polder': [
        { keyword: 'bedford ijswagen huren', topic: 'De Bedford ijswagen: een iconische beleving op je feest' },
        { keyword: 'gelatobar huren', topic: 'Gelatobar huren: de stijlvolle keuze voor je receptie of bruiloft' },
        { keyword: 'ijswagen huren kosten', topic: 'Wat kost het om een ijswagen te huren? Eerlijk overzicht van alle kosten' },
        { keyword: 'ijsscooter huren', topic: 'IJsscooter huren: de verrassende eyecatcher op je feest' },
        { keyword: 'ijswagen huren kinderfeest', topic: 'IJswagen huren voor een kinderfeest: tips en ideeën' },
        { keyword: 'ijswagen huren Flevoland', topic: 'IJswagen huren in Flevoland: lokaal ambachtelijk ijs op je evenement' },
        { keyword: 'ijswagen huren Veluwe', topic: 'IJswagen huren op de Veluwe: van Harderwijk tot Nijkerk' },
        { keyword: 'duurzaam ijs evenement', topic: 'Duurzaam en natuurlijk ijs op je evenement: waar let je op?' },
      ],
      'IP Voice Shop': [
        { keyword: 'beste headset Teams 2026', topic: 'Beste headset voor Microsoft Teams in 2026: top 5 vergelijking' },
        { keyword: 'Jabra Evolve2 vs Yealink', topic: 'Jabra Evolve2 vs Yealink BH76: welke kies je?' },
        { keyword: 'zakelijke conferentie speaker', topic: 'Beste conferentie speakers voor de vergaderruimte' },
        { keyword: 'VoIP telefoon kantoor', topic: 'De beste VoIP telefoons voor op kantoor in 2026' },
      ],
    };

    for (const bedrijf of bedrijven) {
      const topics = blogTopics[bedrijf.title];
      if (!topics || topics.length === 0) continue;

      // Check how many blogs already exist for this bedrijf
      const existingBlogs = await directus.request(
        readItems('Posts', {
          filter: {
            bedrijf: { _eq: bedrijf.id },
            post_type: { _eq: 'blog' },
          },
          fields: ['title'],
        })
      ) as Array<{ title: string }>;

      const existingTitles = existingBlogs.map(b => b.title.toLowerCase());

      // Find a topic that hasn't been written about yet
      // Check if the full keyword (or significant portion) appears in existing titles
      const unusedTopic = topics.find(t => {
        const keywordLower = t.keyword.toLowerCase();
        // Check if any existing title contains the main keywords (at least 2 words if multi-word keyword)
        const keywordWords = keywordLower.split(' ');
        const searchPhrase = keywordWords.length >= 2
          ? keywordWords.slice(0, 2).join(' ')  // First 2 words for multi-word keywords
          : keywordWords[0];  // Single word keywords

        return !existingTitles.some(title => title.includes(searchPhrase));
      });

      if (unusedTopic) {
        await blogGenerationQueue.add(
          `auto-blog-${bedrijf.id}-${Date.now()}`,
          {
            bedrijfId: bedrijf.id,
            keyword: unusedTopic.keyword,
            topic: unusedTopic.topic,
            targetWordCount: 1000,
          },
          { priority: 5 }
        );
        logger.info(`Auto-blog queued for ${bedrijf.title}: "${unusedTopic.keyword}"`);
      } else {
        logger.info(`All blog topics used for ${bedrijf.title}, skipping`);
      }
    }
  } catch (error) {
    logger.error('Blog auto-generator error:', error);
  }
});

// Check for approved blogs ready to publish - every 5 minutes
const blogPublishScheduler = new CronJob('*/5 * * * *', async () => {
  try {
    const { directus } = await import('../config/directus');
    const { readItems, updateItem } = await import('@directus/sdk');

    const blogs = await directus.request(
      readItems('Posts', {
        filter: {
          post_type: { _eq: 'blog' },
          approval_status: { _eq: 'approved' },
          published_at: { _null: true },
        },
      })
    ) as Array<{ id: number }>;

    if (blogs.length === 0) return;

    logger.info(`Found ${blogs.length} approved blogs ready to publish`);

    for (const blog of blogs) {
      // Mark as publishing to prevent duplicate queue entries
      await directus.request(
        updateItem('Posts', blog.id, { approval_status: 'publishing' })
      );

      await blogPublishQueue.add(
        `blog-publish-${blog.id}`,
        { postId: blog.id }
      );
    }
  } catch (error) {
    logger.error('Blog publish scheduler error:', error);
  }
});

// Sync Rank Math SEO data - every 12 hours (06:30 and 18:30)
const seoSyncScheduler = new CronJob('30 6,18 * * *', async () => {
  try {
    const bedrijven = await db.getBedrijven();

    for (const bedrijf of bedrijven) {
      await seoSyncQueue.add(
        `seo-sync-${bedrijf.id}`,
        { bedrijfId: bedrijf.id }
      );
    }
  } catch (error) {
    logger.error('SEO sync scheduler error:', error);
  }
});

// Generate AI suggestions - daily at 07:30
const suggestionsScheduler = new CronJob('30 7 * * *', async () => {
  try {
    const bedrijven = await db.getBedrijven();

    for (const bedrijf of bedrijven) {
      await suggestionsQueue.add(
        `suggestions-${bedrijf.id}`,
        { bedrijfId: bedrijf.id }
      );
    }
  } catch (error) {
    logger.error('Suggestions scheduler error:', error);
  }
});

// Poll IJs email inbox - every 3 minutes (only enqueues; worker checks flag)
const emailInboxScheduler = new CronJob('*/3 * * * *', async () => {
  try {
    if (env.IJS_EMAIL_AGENT_ENABLED !== 'true') return;
    await emailInboxQueue.add(
      `poll-ijs-${Date.now()}`,
      { source: 'cron' },
      { removeOnComplete: true, removeOnFail: false },
    );
  } catch (error) {
    logger.error('Email inbox scheduler error:', error);
  }
});

// Sync blog analytics - every 6 hours
const blogAnalyticsScheduler = new CronJob('0 */6 * * *', async () => {
  try {
    const bedrijven = await db.getBedrijven();

    for (const bedrijf of bedrijven) {
      await blogAnalyticsQueue.add(
        `blog-analytics-${bedrijf.id}`,
        { bedrijfId: bedrijf.id }
      );
    }
  } catch (error) {
    logger.error('Blog analytics scheduler error:', error);
  }
});

// Verteller (content-agent): genereert zelfsturend blogs uit de Content Map (di + vr 08:00)
const vertellerScheduler = new CronJob('0 8 * * 2,5', async () => {
  try {
    const { directus } = await import('../config/directus');
    const { readItems, updateItem } = await import('@directus/sdk');
    const { blogGenerationQueue } = await import('./queues');
    for (const bedrijfId of [5, 7]) {
      const topics = (await directus.request(readItems('Cluster_Topics', {
        filter: { bedrijf: { _eq: bedrijfId }, status: { _eq: 'planned' } }, sort: ['sort', 'id'], limit: 2,
      }))) as any[];
      for (const t of topics) {
        await blogGenerationQueue.add(`verteller-${t.id}`, {
          bedrijfId, keyword: t.keyword,
          topic: t.type === 'pillar' ? `Pillar-artikel over ${t.keyword}` : undefined,
          topicId: t.id, targetWordCount: 1000,
        }, { priority: 4 });
        await directus.request(updateItem('Cluster_Topics', t.id, { status: 'generating' }));
        logger.info(`Verteller queued blog: "${t.keyword}" (topic ${t.id})`);
      }
    }
  } catch (error) {
    logger.error('Verteller scheduler error:', error);
  }
});

// Spotter (GEO-agent): wekelijkse AI-vindbaarheid scan voor beide bedrijven (ma 09:00)
const spotterScheduler = new CronJob('0 9 * * 1', async () => {
  try {
    const { runGeoScan } = await import('../seo/geo-radar');
    for (const bedrijfId of [5, 7]) {
      await runGeoScan(bedrijfId).catch((e) => logger.warn(`Spotter scan bedrijf ${bedrijfId} faalde:`, e));
    }
    logger.info('Spotter GEO-scan klaar voor beide bedrijven');
  } catch (error) {
    logger.error('Spotter scheduler error:', error);
  }
});

// Speurder — wekelijkse Google Search Console sync (echte zoekdata -> Content Map)
const speurderScheduler = new CronJob('0 6 * * 1', async () => {
  try {
    const { syncGscVoorBedrijf, gscConfigured } = await import('../seo/gsc-sync');
    if (!gscConfigured()) {
      logger.info('Speurder: GSC niet geconfigureerd, sync overgeslagen');
      return;
    }
    for (const bedrijfId of [5, 6, 7]) {
      await syncGscVoorBedrijf(bedrijfId)
        .then((r) => logger.info(`Speurder GSC bedrijf ${bedrijfId}: ${r.queries} queries, ${r.totaal_impressies} impressies, ${r.topic_volumes_bijgewerkt} volumes bijgewerkt`))
        .catch((e) => logger.warn(`Speurder GSC bedrijf ${bedrijfId} faalde:`, e));
    }
    logger.info('Speurder GSC-sync klaar');
  } catch (error) {
    logger.error('Speurder scheduler error:', error);
  }
});

// Penning — dagelijkse kosten-sync uit Moneybird (werkt zodra IJS_MONEYBIRD_API_TOKEN staat)
const kostenScheduler = new CronJob('30 5 * * *', async () => {
  try {
    const { syncKostenUitMoneybird } = await import('../finance/controller');
    const r = await syncKostenUitMoneybird(7);
    logger.info(`Penning kosten-sync klaar: ${JSON.stringify(r)}`);
  } catch (error) {
    logger.warn('Penning kosten-sync overgeslagen:', (error as Error).message);
  }
});

// Offerte-sync — getekende Moneybird-offertes elke 2 uur in de Boekingen/planning
// Elk uur: getekende offertes uit Moneybird halen EN verwerken naar de planning
// (datum, locatie, middel uit de offerte), zodat een net getekende offerte vanzelf
// in de planning verschijnt zonder dat iemand het hoeft te vragen.
const offerteScheduler = new CronJob('15 * * * *', async () => {
  try {
    const { syncOffertes } = await import('../finance/offerte-sync');
    const sync = await syncOffertes(7);
    const { laadMoneybirdHistorie } = await import('../agents/historie-loader');
    const parse = await laadMoneybirdHistorie(7);
    logger.info(`Offerte-sync + planning klaar: ${sync.nieuw} nieuw, ${sync.gewonnen} gewonnen; ${parse.bijgewerkt} in planning gezet, ${parse.zonder_datum} nog zonder datum`);
  } catch (error) {
    logger.warn('Offerte-sync overgeslagen:', (error as Error).message);
  }
});

// Mail-archief — incrementeel nieuwe mail archiveren (Bode's geheugen)
const mailArchiefScheduler = new CronJob('0 */6 * * *', async () => {
  try {
    const { backfillMailArchief } = await import('../agents/mail-archief');
    const r = await backfillMailArchief(7, { maxPerMap: 150 });
    logger.info(`Mail-archief sync klaar: ${JSON.stringify(r)}`);
  } catch (error) {
    logger.error('Mail-archief scheduler error:', error);
  }
});

// Integratie-check: dagelijks kijken welke koppelingen missen/verlopen en daar
// taken voor klaarzetten (zodat ontbrekende API-keys vanzelf op de Takenlijst komen)
const integratieScheduler = new CronJob('0 7 * * *', async () => {
  try {
    const { checkIntegraties } = await import('../agents/integratie-check');
    const r = await checkIntegraties();
    logger.info(`Integratie-check klaar: ${JSON.stringify(r)}`);
  } catch (error) {
    logger.error('Integratie-check scheduler error:', error);
  }
});

// ============================================
// Start/Stop all cron jobs
// ============================================

const allJobs = [
  { name: 'Integratie-check (daily 07:00)', job: integratieScheduler },
  { name: 'Engagement Sync (*/30 min)', job: engagementScheduler },
  { name: 'Token Refresh (*/6 hours)', job: tokenScheduler },
  { name: 'Weekly Report (Mon 08:00)', job: weeklyReportScheduler },
  { name: 'Blog Analytics (*/6 hours)', job: blogAnalyticsScheduler },
  { name: 'SEO Sync - Rank Math (2x/day 06:30+18:30)', job: seoSyncScheduler },
  { name: 'Email Inbox Poll - IJs (*/3 min)', job: emailInboxScheduler },
  // === Uitgezet: kost AI-credits aan content die niet gepost wordt, of API's
  //     zijn er nog niet (publiceren is nu handwerk via de post-kalender).
  //     Weer aanzetten zodra de social-API's gekoppeld zijn.
  // { name: 'Content Generator (daily 06:00)', job: contentScheduler },
  // { name: 'Blog Auto-Generator (Mon+Thu 07:00)', job: blogAutoGenerator },
  // { name: 'Verteller - content uit Content Map (Tue+Fri 08:00)', job: vertellerScheduler },
  // { name: 'Publish Scheduler (*/2 min)', job: publishScheduler },
  // { name: 'Blog Publish (*/5 min)', job: blogPublishScheduler },
  // Oude AI-suggesties (regel-motor) uitgezet: vervangen door Maestro/Vandaag.
  // { name: 'AI Suggestions (daily 07:30)', job: suggestionsScheduler },
  { name: 'Spotter - GEO scan (Mon 09:00)', job: spotterScheduler },
  { name: 'Speurder - GSC sync (Mon 06:00)', job: speurderScheduler },
  { name: 'Mail-archief sync (*/6 hours)', job: mailArchiefScheduler },
  { name: 'Offerte-sync + planning Moneybird (elk uur)', job: offerteScheduler },
  { name: 'Penning kosten-sync (daily 05:30)', job: kostenScheduler },
];

export function startCronJobs(): void {
  for (const { name, job } of allJobs) {
    job.start();
    logger.info(`â° Cron started: ${name}`);
  }
}

export function stopCronJobs(): void {
  for (const { name, job } of allJobs) {
    job.stop();
    logger.info(`â¹ï¸ Cron stopped: ${name}`);
  }
}
