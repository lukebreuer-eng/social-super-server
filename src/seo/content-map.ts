import { db, ClusterTopic, ContentCluster } from '../config/directus';
import { logger } from '../utils/logger';

export interface ContentMapTopic extends ClusterTopic {}

export interface ContentMapCluster extends ContentCluster {
  topics: ContentMapTopic[];
  counts: { total: number; planned: number; generating: number; published: number };
}

export interface ContentMap {
  bedrijfId: number;
  totals: { clusters: number; topics: number; planned: number; generating: number; published: number };
  clusters: ContentMapCluster[];
}

/**
 * Bouwt de topical map voor een bedrijf: clusters met hun topics genest,
 * plus status-tellingen per cluster en totaal. Voedt de Content Map dashboard-tab.
 */
export async function getContentMap(bedrijfId: number): Promise<ContentMap> {
  const [clusters, topics] = await Promise.all([
    db.getClusters(bedrijfId),
    db.getTopics(bedrijfId),
  ]);

  const byCluster = new Map<number, ClusterTopic[]>();
  for (const t of topics) {
    const list = byCluster.get(t.cluster) || [];
    list.push(t);
    byCluster.set(t.cluster, list);
  }

  const totals = { clusters: clusters.length, topics: 0, planned: 0, generating: 0, published: 0 };

  const enriched: ContentMapCluster[] = clusters.map((c) => {
    const ts = byCluster.get(c.id) || [];
    // pillar eerst, daarna op zoekvolume (indien aanwezig)
    ts.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'pillar' ? -1 : 1;
      return (b.zoekvolume || 0) - (a.zoekvolume || 0);
    });
    const counts = {
      total: ts.length,
      planned: ts.filter((t) => t.status === 'planned').length,
      generating: ts.filter((t) => t.status === 'generating').length,
      published: ts.filter((t) => t.status === 'published').length,
    };
    totals.topics += counts.total;
    totals.planned += counts.planned;
    totals.generating += counts.generating;
    totals.published += counts.published;
    return { ...c, topics: ts, counts };
  });

  return { bedrijfId, totals, clusters: enriched };
}

/**
 * Start blog-generatie voor een topic: zet de topic op 'generating' en queue
 * de bestaande blog-generatie pijplijn met topicId zodat de worker terugkoppelt.
 */
export async function generateBlogForTopic(topicId: number): Promise<{ jobId: string; keyword: string }> {
  const topic = await db.getTopic(topicId);
  if (!topic) throw new Error(`Topic ${topicId} not found`);

  const { blogGenerationQueue } = await import('../scheduler/queues');
  const job = await blogGenerationQueue.add(
    `topic-${topic.bedrijf}-${topic.keyword}`,
    {
      bedrijfId: topic.bedrijf,
      keyword: topic.keyword,
      topic: topic.type === 'pillar' ? `Pillar-artikel over ${topic.keyword}` : undefined,
      topicId: topic.id,
    },
    { priority: 1 }
  );

  await db.updateTopic(topicId, { status: 'generating' });
  logger.info(`Queued blog generation for topic ${topicId} ("${topic.keyword}"), job ${job.id}`);

  return { jobId: String(job.id), keyword: topic.keyword };
}
