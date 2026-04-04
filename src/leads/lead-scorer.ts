import { db, Lead, directus } from '../config/directus';
import { readItems, updateItem } from '@directus/sdk';
import { logger } from '../utils/logger';

// ============================================
// Lead Scoring Engine
// ============================================

interface LeadScoreResult {
  leadId: number;
  score: number;
  temperature: string;
  factors: string[];
}

// Score weights
const SCORE_WEIGHTS = {
  // Source quality
  source_organic: 10,
  source_social: 15,
  source_referral: 20,
  source_paid: 12,
  source_direct: 8,

  // UTM completeness
  has_utm_source: 5,
  has_utm_medium: 5,
  has_utm_campaign: 10,

  // Contact completeness
  has_email: 15,
  has_phone: 10,
  has_company: 10,

  // Source post engagement
  from_high_engagement_post: 15,

  // Repeat visitor
  repeat_visitor: 20,
};

export async function processLead(leadId: number): Promise<LeadScoreResult> {
  const leadResults = await directus.request(
    readItems('Leads', { filter: { id: { _eq: leadId } }, limit: 1 })
  ) as Lead[];

  if (!leadResults || leadResults.length === 0) {
    throw new Error(`Lead ${leadId} not found`);
  }

  const lead = leadResults[0];
  let score = 0;
  const factors: string[] = [];

  // Source scoring
  const sourceKey = `source_${lead.bron}` as keyof typeof SCORE_WEIGHTS;
  if (SCORE_WEIGHTS[sourceKey]) {
    score += SCORE_WEIGHTS[sourceKey];
    factors.push(`Bron: ${lead.bron} (+${SCORE_WEIGHTS[sourceKey]})`);
  }

  // UTM scoring
  if (lead.utm_source) {
    score += SCORE_WEIGHTS.has_utm_source;
    factors.push('UTM source aanwezig');
  }
  if (lead.utm_medium) {
    score += SCORE_WEIGHTS.has_utm_medium;
    factors.push('UTM medium aanwezig');
  }
  if (lead.utm_campaign) {
    score += SCORE_WEIGHTS.has_utm_campaign;
    factors.push('UTM campaign aanwezig');
  }

  // Contact completeness
  if (lead.email) {
    score += SCORE_WEIGHTS.has_email;
    factors.push('Email beschikbaar');
  }
  if (lead.telefoon) {
    score += SCORE_WEIGHTS.has_phone;
    factors.push('Telefoon beschikbaar');
  }
  if (lead.bedrijf_naam) {
    score += SCORE_WEIGHTS.has_company;
    factors.push('Bedrijfsnaam beschikbaar');
  }

  // Check if lead came from a high-engagement post
  if (lead.bron_post) {
    const posts = await directus.request(
      readItems('Posts', { filter: { id: { _eq: lead.bron_post } }, limit: 1 })
    );
    if (posts.length > 0) {
      const post = posts[0] as { engagement_score?: number };
      if (post.engagement_score && post.engagement_score > 50) {
        score += SCORE_WEIGHTS.from_high_engagement_post;
        factors.push('Afkomstig van high-engagement post');
      }
    }
  }

  // Cap score at 100
  score = Math.min(100, score);

  // Determine temperature
  const temperature = getTemperature(score);

  await directus.request(
    updateItem('Leads', leadId, {
      lead_score: score,
      lead_temperature: temperature,
      status: temperature === 'hot' ? 'qualified' : 'scored',
    })
  );

  logger.info(`Lead ${leadId} scored: ${score} (${temperature}) - ${factors.length} factors`);

  return {
    leadId,
    score,
    temperature,
    factors,
  };
}

function getTemperature(score: number): string {
  if (score >= 70) return 'hot';
  if (score >= 40) return 'warm';
  return 'cold';
}

// ============================================
// Capture lead from UTM parameters
// ============================================

export async function captureLead(data: {
  naam: string;
  email: string;
  telefoon?: string;
  bedrijf_naam?: string;
  bedrijfId: number;
  bron: string;
  bron_post?: number;
  bron_url: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
}): Promise<Lead> {
  const lead = await db.createLead({
    status: 'new',
    naam: data.naam,
    email: data.email,
    telefoon: data.telefoon || '',
    bedrijf_naam: data.bedrijf_naam || '',
    bedrijf: data.bedrijfId,
    bron: data.bron,
    bron_post: data.bron_post || null,
    bron_url: data.bron_url,
    utm_source: data.utm_source || '',
    utm_medium: data.utm_medium || '',
    utm_campaign: data.utm_campaign || '',
    lead_score: 0,
    lead_temperature: 'cold',
    notities: '',
  });

  logger.info(`New lead captured: ${data.naam} (${data.email}) via ${data.bron}`);
  return lead;
}

logger.info('✅ Lead Scorer initialized');
